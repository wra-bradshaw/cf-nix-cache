# Shared crane/Rust setup for packages and checks: one workspace source and
# one host dependency build.
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
    ;
}
