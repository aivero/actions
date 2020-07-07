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

    const conan_path = `${process.env.HOME}/.local/bin/conan`;
    await exec(`${conan_path} config install ${process.env.CONAN_CONFIG_URL} -sf ${process.env.CONAN_CONFIG_DIR}`);
    await exec(`${conan_path} user ${process.env.CONAN_LOGIN_USERNAME} -p ${process.env.CONAN_LOGIN_PASSWORD} -r ${inputs.conan_repo}`);
    await exec(`${conan_path} config set general.default_profile=${inputs.profile}`);
    await exec(`${conan_path} create ${inputs.path} ${inputs.package}@`);
    await exec(`${conan_path} upload ${inputs.package} --all -c -r ${inputs.conan_repo}`);

  } catch (error) {
    core.debug(inspect(error));
    core.setFailed(error.message);
  }
}

run();
