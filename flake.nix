{
  description = "A Cloudflare-native, Nix-compatible binary cache";

  inputs.nixpkgs.url = "https://flakehub.com/f/NixOS/nixpkgs/0";
  inputs.crane.url = "github:ipetkov/crane";
  inputs.fenix = {
    url = "github:nix-community/fenix";
    inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    inputs:
    let
      inherit (inputs.nixpkgs) lib;
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forEachSupportedSystem =
        f:
        lib.genAttrs supportedSystems (
          system:
          f {
            inherit system;
            pkgs = import inputs.nixpkgs {
              inherit system;
              config.allowUnfree = true;
            };
          }
        );
      packages = import ./nix/packages.nix {
        inherit inputs lib forEachSupportedSystem;
      };
    in
    {
      formatter = forEachSupportedSystem ({ pkgs, ... }: pkgs.nixfmt);
      devShells = import ./nix/dev-shells.nix {
        inherit lib forEachSupportedSystem;
      };
      apps = import ./nix/apps.nix {
        inherit forEachSupportedSystem;
      };
      inherit packages;
      checks = import ./nix/checks.nix {
        inherit
          inputs
          lib
          packages
          forEachSupportedSystem
          ;
      };
    };
}
