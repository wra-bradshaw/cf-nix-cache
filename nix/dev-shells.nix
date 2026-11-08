{ inputs, lib, forEachSupportedSystem }:

forEachSupportedSystem (
  { pkgs, system }:
  let
    rust = (import ./rust.nix { inherit inputs lib; }) {
      inherit pkgs system;
    };
  in
  {
    default = pkgs.mkShellNoCC {
      packages =
        with pkgs;
        [
          # Same Rust toolchain as the crane checks/builds (plus rust-src and
          # rust-analyzer for in-shell use) so local cargo agrees with CI.
          rust.devToolchain
          cargo-hakari
          nodejs
          pnpm
          nix
          zstd
        ]
        ++ lib.optionals pkgs.stdenv.isDarwin [
          pkgs.llvmPackages.clang
          pkgs.libiconv
          pkgs.darwin.cctools
        ];
      # Explicit marker for apps.nix ("am I inside the dev shell?"). The wasm
      # verifier is built by the `verifier` Nix package now, so the shell no
      # longer sets CC_wasm32_unknown_unknown/AR_wasm32_unknown_unknown or
      # ships lld for in-shell wasm builds.
      env = {
        CF_NIX_CACHE_DEV_SHELL = "1";
      };
      shellHook = lib.optionalString pkgs.stdenv.isDarwin ''
        export CC="${pkgs.llvmPackages.clang}/bin/clang"
        export CXX="${pkgs.llvmPackages.clang}/bin/clang++"
        export NIX_LDFLAGS="-L${pkgs.libiconv}/lib ''${NIX_LDFLAGS:-}"
        export LIBRARY_PATH="${pkgs.libiconv}/lib:''${LIBRARY_PATH:-}"
      '';
    };
  }
)
