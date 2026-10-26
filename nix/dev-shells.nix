{ lib, forEachSupportedSystem }:

forEachSupportedSystem (
  { pkgs, ... }:
  {
    default = pkgs.mkShellNoCC {
      packages =
        with pkgs;
        [
          cargo
          cargo-hakari
          clippy
          rustc
          rustfmt
          nodejs
          pnpm
          docker-client
          nix
          zstd
        ]
        ++ lib.optionals pkgs.stdenv.isDarwin [
          pkgs.llvmPackages.clang
          pkgs.libiconv
          pkgs.darwin.cctools
        ];
      shellHook = lib.optionalString pkgs.stdenv.isDarwin ''
        export CC="${pkgs.llvmPackages.clang}/bin/clang"
        export CXX="${pkgs.llvmPackages.clang}/bin/clang++"
        export NIX_LDFLAGS="-L${pkgs.libiconv}/lib ''${NIX_LDFLAGS:-}"
        export LIBRARY_PATH="${pkgs.libiconv}/lib:''${LIBRARY_PATH:-}"
      '';
    };
  }
)
