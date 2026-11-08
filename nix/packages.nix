{
  inputs,
  lib,
  forEachSupportedSystem,
}:

forEachSupportedSystem (
  { pkgs, system }:
  let
    rust = (import ./rust.nix { inherit inputs lib; }) {
      inherit pkgs system;
    };
    cli = rust.craneLib.buildPackage (
      rust.commonArgs
      // {
        cargoArtifacts = rust.cargoArtifacts;
        cargoExtraArgs = "--locked -p cf-nix-cache";
        doCheck = false;
      }
    );
  in
  {
    inherit cli;
    default = cli;
  }
)
