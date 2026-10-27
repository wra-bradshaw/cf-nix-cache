{ forEachSupportedSystem }:

forEachSupportedSystem (
  { pkgs, ... }:
  let
    prepareImage = pkgs.writeShellApplication {
      name = "cf-nix-cache-prepare-image";
      runtimeInputs = [
        pkgs.coreutils
        pkgs.docker-client
        pkgs.nix
      ];
      text = ''
        image_name="cf-nix-cache-processor"
        image_path="$(nix build .#packages.x86_64-linux.processorImage --no-link --print-out-paths)"
        image_hash="$(basename "$image_path" | cut -d- -f1)"
        image_tag="$image_name:nix-$image_hash"
        image_marker=".wrangler/nix-processor-image-$image_hash"

        mkdir -p .wrangler
        image_id=""
        if image_id="$(docker image inspect "$image_tag" --format '{{.Id}}' 2>/dev/null)"; then
          :
        else
          image_id=""
        fi
        expected_marker="$(printf '%s\n%s\n' "$image_path" "$image_id")"

        if [ -z "$image_id" ] || [ "$(cat "$image_marker" 2>/dev/null || true)" != "$expected_marker" ]; then
          docker load --input "$image_path" >/dev/null
          docker tag "$image_name:nix" "$image_tag"
          image_id="$(docker image inspect "$image_tag" --format '{{.Id}}')"
          printf '%s\n%s\n' "$image_path" "$image_id" > "$image_marker"
        fi

        printf '%s\n' "$image_tag"
      '';
    };
    deploy = pkgs.writeShellApplication {
      name = "cf-nix-cache-deploy";
      runtimeInputs = [
        pkgs.coreutils
        pkgs.gawk
        pkgs.gnugrep
        pkgs.nodejs
        pkgs.pnpm
        prepareImage
      ];
      text = ''
        action="''${1:-plan}"
        if [ "$#" -gt 0 ]; then shift; fi
        case "$action" in plan|apply|destroy) ;; *) echo "usage: deploy [plan|apply|destroy]" >&2; exit 2 ;; esac

        # wrangler.jsonc is the source of truth. The production R2 bucket name
        # is read from it so it cannot drift from the Worker binding.
        # shellcheck disable=SC2016 # the single-quoted program is JavaScript.
        prod_bucket="$(node -e '
          const fs = require("node:fs");
          let source = fs.readFileSync("wrangler.jsonc", "utf8");
          source = source.replace(/\/\*[\s\S]*?\*\//g, "");
          source = source.replace(/(^|[^:])\/\/.*$/gm, "$1");
          source = source.replace(/,\s*([}\]])/g, "$1");
          const config = JSON.parse(source);
          const bucket = (config.env?.production?.r2_buckets ?? []).find((b) => b.binding === "CACHE_BUCKET")?.bucket_name;
          if (!bucket) { console.error("CACHE_BUCKET is not configured in env.production"); process.exit(1); }
          process.stdout.write(bucket);
        ')"

        w() {
          pnpm --dir packages/worker exec wrangler "$@" --config "$PWD/wrangler.jsonc"
        }

        ensure_bucket_and_lifecycle() {
          # `wrangler r2 bucket list` has no JSON output; each bucket is a
          # labelled block with a `name:  <bucket>` line. Match that line
          # exactly, and let a failed listing abort instead of masking it.
          buckets="$(w r2 bucket list)"
          if ! printf '%s\n' "$buckets" | awk -v bucket="$prod_bucket" '
            { gsub(/\033\[[0-9;]*m/, "") }
            $1 == "name:" && $2 == bucket && NF == 2 { found = 1 }
            END { exit found ? 0 : 1 }
          '; then
            w r2 bucket create "$prod_bucket"
          fi
          lifecycle="$(w r2 bucket lifecycle list "$prod_bucket")"
          if ! printf '%s' "$lifecycle" | grep -q "abandoned-staging"; then
            w r2 bucket lifecycle add "$prod_bucket" \
              abandoned-staging "staging/" --expire-days 1 --force
          fi
          if ! printf '%s' "$lifecycle" | grep -q "abort-multipart"; then
            w r2 bucket lifecycle add "$prod_bucket" \
              abort-multipart "" --abort-multipart-days 1 --force
          fi
        }

        check_secrets() {
          secret_json="$(pnpm --dir packages/worker exec wrangler secret list \
            --config "$PWD/wrangler.jsonc" \
            --env production \
            --format json)"
          for secret in AUTH_PRIVATE_JWK AUTH_PUBLIC_JWKS NIX_PRIVATE_JWK NIX_PUBLIC_KEYS BOOTSTRAP_SECRET_HASH; do
            if ! printf '%s' "$secret_json" | node -e '
              const fs = require("node:fs");
              const wanted = process.argv[1];
              const parsed = JSON.parse(fs.readFileSync(0, "utf8"));
              const entries = Array.isArray(parsed) ? parsed : parsed.secrets ?? [];
              const names = entries.map((entry) => entry.name);
              process.exit(names.includes(wanted) ? 0 : 1);
            ' "$secret"; then
              echo "missing Wrangler secret: $secret" >&2
              exit 1
            fi
          done
        }

        case "$action" in
          plan)
            # Validates the Worker bundle without pushing images or touching
            # account resources.
            CLOUDFLARE_ENV=production \
              CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH="$PWD/wrangler.jsonc" \
              pnpm --dir packages/worker build
            w deploy --dry-run --env production
            ;;
          destroy)
            echo "Refusing to destroy automatically: deleting the Worker does not delete" >&2
            echo "a non-empty R2 bucket. To tear down '$prod_bucket', stop writers, verify" >&2
            echo "the bucket is empty, then run:" >&2
            echo "  wrangler r2 object list $prod_bucket" >&2
            echo "  wrangler r2 bucket delete $prod_bucket" >&2
            exit 2
            ;;
          apply)
            : "''${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required for apply}"
            : "''${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required for apply}"

            check_secrets
            ensure_bucket_and_lifecycle

            # Wrangler builds the Dockerfile on top of the loaded Nix image and
            # pushes it to the account's registry during deploy.
            image_ref="$(cf-nix-cache-prepare-image)"
            rendered_config=".wrangler.production.json"
            node packages/worker/scripts/render-wrangler-config.mts \
              --input wrangler.jsonc \
              --output "$rendered_config" \
              --image "$image_ref"
            CLOUDFLARE_ENV=production \
              CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH="$PWD/$rendered_config" \
              pnpm --dir packages/worker build

            pnpm --dir packages/worker exec wrangler deploy \
              --config "$PWD/$rendered_config" \
              --env production
            ;;
        esac
      '';
    };
    dev = pkgs.writeShellApplication {
      name = "cf-nix-cache-dev";
      runtimeInputs = [
        pkgs.coreutils
        pkgs.docker-client
        pkgs.nodejs
        pkgs.pnpm
        prepareImage
      ];
      text = ''
        image_ref="$(cf-nix-cache-prepare-image)"
        docker tag "$image_ref" "cf-nix-cache-processor:nix-local"
        exec pnpm --dir packages/worker dev "$@"
      '';
    };
  in
  {
    default = {
      type = "app";
      program = "${deploy}/bin/cf-nix-cache-deploy";
    };
    deploy = {
      type = "app";
      program = "${deploy}/bin/cf-nix-cache-deploy";
    };
    dev = {
      type = "app";
      program = "${dev}/bin/cf-nix-cache-dev";
    };
  }
)
