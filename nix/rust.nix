# Shared crane/Rust setup for packages and checks: one workspace source, one
# host dependency build, and one wasm32 dependency build.
{ inputs, lib }:
{ pkgs, system }:
let
  workspaceFileset = lib.fileset.unions [
    ../Cargo.toml
    ../Cargo.lock
    ../crates
    ../schemas
  ];
  workspaceSrc = lib.fileset.toSource {
    root = ../.;
    fileset = workspaceFileset;
  };
  # cargo-hakari only reads the workspace manifests, the lockfile and its own
  # config; crate sources and everything outside the Rust workspace are
  # excluded so unrelated changes don't invalidate the check.
  hakariSrc = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      workspaceFileset
      ../.config/hakari.toml
    ];
  };
  workspaceVersion = (builtins.fromTOML (builtins.readFile ../Cargo.toml)).workspace.package.version;

  # Fenix must provide every binary crane invokes (cargo, rustc, clippy,
  # rustfmt) so checks and builds share one toolchain.
  toolchain = inputs.fenix.packages.${system}.stable.withComponents [
    "cargo"
    "rustc"
    "clippy"
    "rustfmt"
  ];
  craneLib = (inputs.crane.mkLib pkgs).overrideToolchain toolchain;

  commonArgs = {
    src = workspaceSrc;
    strictDeps = true;
    pname = "cf-nix-cache";
    version = workspaceVersion;
  };

  # One host dependency derivation shared by clippy, tests and the CLI.
  cargoArtifacts = craneLib.buildDepsOnly commonArgs;

  # The verifier's rust-std for wasm32, combined with the host tools above.
  wasmToolchain = inputs.fenix.packages.${system}.combine [
    (inputs.fenix.packages.${system}.stable.withComponents [
      "cargo"
      "rustc"
    ])
    inputs.fenix.packages.${system}.targets.wasm32-unknown-unknown.stable.rust-std
  ];
  wasmCraneLib = (inputs.crane.mkLib pkgs).overrideToolchain wasmToolchain;

  # zstd-sys compiles its C sources for wasm32 with an unwrapped clang (the
  # wrapped clang targets the host only). rustc links with its bundled
  # rust-lld; `lld` is included to match the previous dev-shell setup.
  wasmArgs = {
    src = workspaceSrc;
    strictDeps = true;
    pname = "cf-nix-cache-verify";
    version = workspaceVersion;
    CARGO_BUILD_TARGET = "wasm32-unknown-unknown";
    CC_wasm32_unknown_unknown = "${pkgs.llvmPackages.clang-unwrapped}/bin/clang";
    AR_wasm32_unknown_unknown = "${pkgs.llvmPackages.bintools-unwrapped}/bin/llvm-ar";
    nativeBuildInputs = [
      pkgs.llvmPackages.clang-unwrapped
      pkgs.llvmPackages.bintools-unwrapped
      pkgs.lld
    ];
    cargoExtraArgs = "--locked -p cf-nix-cache-verify";
  };

  # Its own dependency derivation: these artifacts target wasm32, so they
  # cannot be shared with the host build above.
  wasmCargoArtifacts = wasmCraneLib.buildDepsOnly wasmArgs;
in
{
  inherit
    workspaceFileset
    workspaceSrc
    hakariSrc
    workspaceVersion
    toolchain
    craneLib
    commonArgs
    cargoArtifacts
    wasmCraneLib
    wasmArgs
    wasmCargoArtifacts
    ;
}
