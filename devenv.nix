{ pkgs, lib, config, inputs, ... }:

{
  packages = [ pkgs.git ];

  languages.python = {
    enable = true;
    package = pkgs.python3;
  };

  processes.web.exec = "python ${config.env.DEVENV_ROOT}/server.py";

  scripts.serve.exec = ''
    python "$DEVENV_ROOT/server.py"
  '';

  enterShell = ''
    echo "thock — run 'devenv up' or 'serve' then open http://localhost:8765"
  '';
}
