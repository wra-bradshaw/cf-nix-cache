{ forEachSupportedSystem }:

forEachSupportedSystem (
  { pkgs, ... }:
  let
    deploy = pkgs.writeShellApplication {
      name = "cf-nix-cache-deploy";
      runtimeInputs = [
        pkgs.coreutils
        pkgs.gawk
        pkgs.gnugrep
        pkgs.nodejs
        pkgs.pnpm
      ];
      text = ''
        # `pnpm build` compiles crates/verify to wasm32 with the dev shell's
        # toolchain, so run inside it, with the caller's own `nix`. Like the
        # rest of this app, this expects the repository root as the working
        # directory.
        if [ -z "''${CC_wasm32_unknown_unknown:-}" ]; then
          exec nix develop --command "$0" "$@"
        fi
        action="''${1:-plan}"
        if [ "$#" -gt 0 ]; then shift; fi
        case "$action" in plan|apply|destroy) ;; *) echo "usage: deploy [plan|apply|destroy]" >&2; exit 2 ;; esac

        # wrangler.jsonc is the source of truth. The production R2 bucket name
        # is read from it so it cannot drift from the Worker binding.
        prod_bucket="$(node packages/worker/scripts/production-bucket.mts wrangler.jsonc)"

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
            # Validates the Worker bundle without touching account resources.
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

            CLOUDFLARE_ENV=production \
              CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH="$PWD/wrangler.jsonc" \
              pnpm --dir packages/worker build

            w deploy --env production
            ;;
        esac
      '';
    };
    dev = pkgs.writeShellApplication {
      name = "cf-nix-cache-dev";
      runtimeInputs = [
        pkgs.nodejs
        pkgs.pnpm
      ];
      text = ''
        # `pnpm build` compiles crates/verify to wasm32 with the dev shell's
        # toolchain, so run inside it, with the caller's own `nix`. Like the
        # rest of this app, this expects the repository root as the working
        # directory.
        if [ -z "''${CC_wasm32_unknown_unknown:-}" ]; then
          exec nix develop --command "$0" "$@"
        fi
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
