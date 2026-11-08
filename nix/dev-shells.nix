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
          nix
          zstd
          # The Worker's chunk verifier: crates/verify for wasm32, with zstd's
          # C sources compiled by an unwrapped clang (the wrapper targets the
          # host only).
          lld
        ]
        ++ lib.optionals pkgs.stdenv.isDarwin [
          pkgs.llvmPackages.clang
          pkgs.libiconv
          pkgs.darwin.cctools
        ];
      CC_wasm32_unknown_unknown = "${pkgs.llvmPackages.clang-unwrapped}/bin/clang";
      AR_wasm32_unknown_unknown = "${pkgs.llvmPackages.bintools-unwrapped}/bin/llvm-ar";
      shellHook = lib.optionalString pkgs.stdenv.isDarwin ''
        export CC="${pkgs.llvmPackages.clang}/bin/clang"
        export CXX="${pkgs.llvmPackages.clang}/bin/clang++"
        export NIX_LDFLAGS="-L${pkgs.libiconv}/lib ''${NIX_LDFLAGS:-}"
        export LIBRARY_PATH="${pkgs.libiconv}/lib:''${LIBRARY_PATH:-}"
      '';
    };
  }
)
