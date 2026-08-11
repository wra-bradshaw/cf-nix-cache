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
      version = "0.1.0";
    };
    cargoArtifacts = craneLib.buildDepsOnly (
      common
      // {
        pname = "cf-nix-cache-deps";
        cargoExtraArgs = "--workspace";
      }
    );
    crateArgs = {
      inherit cargoArtifacts;
      src = workspaceSrc;
      strictDeps = true;
      version = "0.1.0";
      doCheck = false;
    };
    separateCli = craneLib.buildPackage (
      crateArgs
      // {
        pname = "cf-nix-cache";
        cargoExtraArgs = "-p cf-nix-cache";
      }
    );
    separateProcessor = craneLib.buildPackage (
      crateArgs
      // {
        pname = "cf-nix-cache-processor";
        cargoExtraArgs = "-p cf-nix-cache-processor";
      }
    );
    workspaceBinaries =
      if system == "x86_64-linux" then
        craneLib.buildPackage (
          crateArgs
          // {
            pname = "cf-nix-cache-workspace";
            cargoExtraArgs = "--workspace";
            installPhaseCommand = ''
              mkdir -p "$out/bin"
              cp target/release/cf-nix-cache "$out/bin/cf-nix-cache"
              cp target/release/cf-nix-cache-processor "$out/bin/cf-nix-cache-processor"
            '';
          }
        )
      else
        null;
    fromWorkspace =
      name: binary:
      pkgs.runCommand name { } ''
        mkdir -p "$out/bin"
        cp ${workspaceBinaries}/bin/${binary} "$out/bin/${binary}"
      '';
    cli =
      if workspaceBinaries != null then
        fromWorkspace "cf-nix-cache-0.1.0" "cf-nix-cache"
      else
        separateCli;
    processor =
      if workspaceBinaries != null then
        fromWorkspace "cf-nix-cache-processor-0.1.0" "cf-nix-cache-processor"
      else
        separateProcessor;
    processorImage = pkgs.dockerTools.buildLayeredImage {
      name = "cf-nix-cache-processor";
      tag = "nix";
      created = "1970-01-01T00:00:01Z";
      contents = [
        processor
        pkgs.cacert
      ];
      config = {
        Entrypoint = [ "${processor}/bin/cf-nix-cache-processor" ];
        Env = [
          "PORT=8080"
          "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
        ];
        ExposedPorts."8080/tcp" = { };
        User = "65532:65532";
        Labels."org.opencontainers.image.title" = "cf-nix-cache-processor";
      };
    };
  in
  {
    inherit cli processor;
    default = cli;
  }
  // lib.optionalAttrs (system == "x86_64-linux") {
    inherit processorImage;
  }
)
