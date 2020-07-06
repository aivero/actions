import * as core from "@actions/core";
import { inspect } from "util";
import { spawn } from "child_process";


async function exec(full_cmd: string) {
  try {
    let args = full_cmd.split(' ');
    let cmd = args.shift();
    if (!cmd) {
      throw new Error(`Invalid command: '${full_cmd}'`);
    }
    const child = spawn(cmd, args);

    for await (const chunk of child.stdout) {
      process.stdout.write(chunk);
    }
    for await (const chunk of child.stderr) {
      process.stderr.write(chunk);
    }
    const exitCode = await new Promise((resolve, reject) => {
      child.on('close', resolve);
    });

    if (exitCode) {
      throw new Error(`Command '${cmd}' failed with code: ${exitCode}`);
    }
  } catch (error) {
    core.debug(inspect(error));
    core.setFailed(error.message);
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

    const [cfg_url, cfg_dir] = inputs.conan_config.split('|');
    const [repo_name, repo_user, repo_password] = inputs.conan_repo.split('|');

    const conan_path = `${process.env.HOME}/.local/bin/conan`;
    await exec(`${conan_path} config install ${cfg_url} -sf ${cfg_dir}`);
    await exec(`${conan_path} user ${repo_user} -p ${repo_password} -r ${repo_name}`);
    await exec(`${conan_path} config set general.default_profile=${inputs.profile}`);
    await exec(`${conan_path} create ${inputs.path} ${inputs.package}@`);
    await exec(`${conan_path} upload ${inputs.package} -r ${repo_name}`);

  } catch (error) {
    core.debug(inspect(error));
    core.setFailed(error.message);
  }
}

run();
