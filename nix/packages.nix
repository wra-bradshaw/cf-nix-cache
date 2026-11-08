{
  inputs,
  lib,
  forEachSupportedSystem,
}:

forEachSupportedSystem (
  { pkgs, system }:
  let
    workspaceSrc = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [
        ../Cargo.toml
        ../Cargo.lock
        ../crates
        ../schemas
      ];
    };
    rustToolchain = inputs.fenix.packages.${system}.stable.withComponents [
      "cargo"
      "rustc"
    ];
    craneLib = (inputs.crane.mkLib pkgs).overrideToolchain rustToolchain;
    common = {
      src = workspaceSrc;
      strictDeps = true;
      version = "0.6.0";
      pname = "cf-nix-cache";
      cargoExtraArgs = "-p cf-nix-cache";
    };
    cli = craneLib.buildPackage (
      common
      // {
        cargoArtifacts = craneLib.buildDepsOnly common;
        doCheck = false;
      }
    );
  in
  {
    inherit cli;
    default = cli;
  }
)
