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
        pkgs.nodejs
        pkgs.pnpm
        pkgs.terraform
        prepareImage
      ];
      text = ''
        action="''${1:-plan}"
        if [ "$#" -gt 0 ]; then shift; fi
        case "$action" in plan|apply|destroy) ;; *) echo "usage: deploy [plan|apply|destroy]" >&2; exit 2 ;; esac

        terraform -chdir=infra init -input=false
        terraform -chdir=infra validate
        case "$action" in
          plan)
            terraform -chdir=infra plan "$@"
            ;;
          destroy)
            terraform -chdir=infra destroy "$@"
            ;;
          apply)
            : "''${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required for apply}"
            : "''${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required for apply}"

            secret_json="$(pnpm --dir apps/worker exec wrangler secret list \
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

            image_ref="$(cf-nix-cache-prepare-image)"
            rendered_config=".wrangler.production.json"
            node apps/worker/scripts/render-wrangler-config.mts \
              --input wrangler.jsonc \
              --output "$rendered_config" \
              --image "registry.cloudflare.com/$CLOUDFLARE_ACCOUNT_ID/$image_ref"
            CLOUDFLARE_ENV=production \
              CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH="$PWD/$rendered_config" \
              pnpm --dir apps/worker build

            pnpm --dir apps/worker exec wrangler containers push \
              "$image_ref" \
              --config "$PWD/wrangler.jsonc"
            terraform -chdir=infra apply "$@"
            pnpm --dir apps/worker exec wrangler deploy \
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
        exec pnpm --dir apps/worker dev "$@"
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
