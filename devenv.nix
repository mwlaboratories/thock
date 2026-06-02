{ pkgs, lib, config, inputs, ... }:

{
  packages = [ pkgs.git ];

  # python3 + soundfile (libsndfile wrapper). scripts/bundle_library.py
  # uses it to encode the curated library's float32 WAVs to 24-bit
  # FLAC — lossless, ~50 % of WAV, browser-decodable via
  # decodeAudioData, and (unlike the standalone flac CLI) handles
  # float WAV input directly. User-recorded samples stay WAV.
  languages.python = {
    enable = true;
    package = pkgs.python3.withPackages (ps: [ ps.soundfile ]);
  };

  processes.web.exec = "python ${config.env.DEVENV_ROOT}/server.py";

  scripts.serve.exec = ''
    python "$DEVENV_ROOT/server.py"
  '';

  enterShell = ''
    echo "thock — run 'devenv up' or 'serve' then open http://localhost:8765"
  '';
}
