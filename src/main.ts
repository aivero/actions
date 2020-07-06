import * as core from "@actions/core";
import * as github from "@actions/github";
import { inspect } from "util";
import { promisify } from "util";
import { spawn, ChildProcess } from "child_process"
import * as path from "path"
import { stringify } from "querystring";

function exec(full_cmd: string) {
  let args = full_cmd.split(' ');
  let cmd = args.shift();
  if (cmd) {
    console.log(`Running: ${full_cmd}`);
    let proc = spawn(cmd, args, { stdio: 'inherit' });
    proc.on('close', (code) => {
      if (code != 0) {
        throw `Command '${full_cmd}' failed with code: ${code}`
      }
    });
  }
}

async function run(): Promise<void> {
  try {
    const inputs = {
      package: core.getInput("package"),
      path: core.getInput("path"),
      profile: core.getInput("profile"),
      conan_config: core.getInput("conan_config"),
      conan_repo: core.getInput("conan_repo"),
    };
    core.debug(`Inputs: ${inspect(inputs)}`);

    const [cfg_url, cfg_dir] = inputs.conan_config.split(':');
    const [repo_name, repo_user, repo_password] = inputs.conan_repo.split(':')

    const conan_path = `${process.env.HOME}/.local/bin/conan`
    exec(`${conan_path} config install ${cfg_url} -sf ${cfg_dir}`);
    exec(`${conan_path} user ${repo_user} -p ${repo_password} -r ${repo_name}`);
    exec(`${conan_path} config set general.default_profile=${inputs.profile}`);
    exec(`${conan_path} create ${inputs.path} ${inputs.package}@`);
    exec(`${conan_path} upload ${inputs.package} -r ${repo_name}`);

  } catch (error) {
    core.debug(inspect(error));
    core.setFailed(error.message);
  }
}

run();
