import * as core from "@actions/core";
import { inspect } from "util";
import { spawn } from "child_process";
import * as coreCommand from "@actions/core/lib/command";
import YAML from "yaml";
import path from "path";
import fs from "fs";
import os from "os";

function sleep(millis) {
  return new Promise((resolve) => setTimeout(resolve, millis));
}

async function exec(
  full_cmd: string,
  fail_on_error = true,
  return_stdout = false,
  env = process.env,
) {
  let args = full_cmd.split(" ");
  let cmd = args.shift();
  if (!cmd) {
    throw new Error(`Invalid command: '${full_cmd}'`);
  }
  core.startGroup(`Running command: '${full_cmd}'`);
  const child = await spawn(
    cmd,
    args,
    { stdio: ["ignore", "pipe", "pipe"], env: env },
  );

  child.stderr.on("data", (data) => {
    if (fail_on_error) {
      core.error(data.toString("utf8"));
    } else {
      core.info(data.toString("utf8"));
    }
  });

  let res = "";
  for await (const chunk of child.stdout) {
    core.info(chunk);
    if (return_stdout) {
      res += chunk;
    }
  }
  core.endGroup();

  const exit_code = await new Promise((resolve, reject) => {
    child.on("close", resolve);
  });

  if (exit_code && fail_on_error) {
    throw new Error(`Command '${full_cmd}' failed with code: ${exit_code}`);
  }
  return res.trim();
}

async function get_pkg_info(name: string, version: string, args: string) {
  const file = `/tmp/${name}.json`;
  await exec(`conan info${args} ${name}/${version}@ --paths --json ${file}`);
  const pkg_info_json = fs.readFileSync(file, "utf8");
  return JSON.parse(pkg_info_json);
}

async function upload_pkg(
  name: string,
  version: string,
  args: string,
  repo: string,
  force_upload = true,
) {
  const info = await get_pkg_info(name, version, args);
  const pkg_path = info[0].package_folder;
  // Only upload if package is not empty (Empty packages contain 2 files: conaninfo.txt and conanmanifest.txt)
  if (force_upload || fs.readdirSync(pkg_path).length > 2) {
    await exec(
      `conan upload ${name}/${version}@ --all -c -r ${repo}`,
    );
  }
}

async function run(): Promise<void> {
  // Always run post
  coreCommand.issueCommand("save-state", { name: "isPost" }, "true");
  try {
    const inputs = {
      package: core.getInput("package"),
      arguments: core.getInput("arguments"),
      settings: core.getInput("settings"),
      options: core.getInput("options"),
      path: core.getInput("path"),
      profile: core.getInput("profile"),
    };
    core.info(`Inputs: ${inspect(inputs)}`);

    // Store package data in environment variables, so they can be used by later Github actions
    let [name, version] = inputs.package.split("/");
    core.exportVariable("CONAN_PKG_NAME", name);
    core.exportVariable("CONAN_PKG_VERSION", version);
    const conan_data_path = await exec(
      "conan config get storage.path",
      true,
      true,
    );
    core.exportVariable("CONAN_DATA_PATH", conan_data_path);
    const conan_pkg_path = path.join(conan_data_path, name, version, "_", "_");
    core.exportVariable("CONAN_PKG_PATH", conan_pkg_path);

    // Conan Setup
    await exec(
      `conan config install ${process.env.CONAN_CONFIG_URL} -sf ${process.env.CONAN_CONFIG_DIR}`,
    );
    await exec(
      `conan user ${process.env.CONAN_LOGIN_USERNAME} -p ${process.env.CONAN_LOGIN_PASSWORD} -r ${process.env.CONAN_REPO_ALL}`,
    );
    await exec(
      `conan user ${process.env.CONAN_LOGIN_USERNAME} -p ${process.env.CONAN_LOGIN_PASSWORD} -r ${process.env.CONAN_REPO_INTERNAL}`,
    );
    await exec(
      `conan user ${process.env.CONAN_LOGIN_USERNAME} -p ${process.env.CONAN_LOGIN_PASSWORD} -r ${process.env.CONAN_REPO_PUBLIC}`,
    );
    await exec(`conan config set general.default_profile=${inputs.profile}`);

    // Workaround to force fetch source until fixed upstream in Conan: https://github.com/conan-io/conan/issues/3084
    await exec(`rm -rf ${path.join(conan_pkg_path, "source")}`);

    // Setup options and settings arguments
    let settings = "";
    if (inputs.settings) {
      settings = " -s " + inputs.settings.split(";").join(" -s ");
    }
    let options = "";
    if (inputs.options) {
      options = " -o " + inputs.options.split(";").join(" -o ");
    }

    // Set number of cores (AWS prevents Conan from detecting number of cores)
    let env = Object.create(process.env);
    env.CONAN_CPU_COUNT = os.cpus().length;

    // Conan create
    const args = `${settings}${options}${inputs.arguments}`;
    await exec(
      `conan create -u${args} ${inputs.path} ${name}/${version}@`,
      true,
      false,
      env,
    );
    await exec(
      `conan create -u${args} ${inputs.path} ${name}-dbg/${version}@`,
      true,
      false,
      env,
    );

    // Select internal or public Conan repository according to license
    const recipe = YAML.parse(
      await exec(
        `conan inspect ${inputs.path}`,
        true,
        true,
      ),
    );
    let conan_repo = process.env.CONAN_REPO_PUBLIC;
    if (recipe["license"].includes("Proprietary")) {
      conan_repo = process.env.CONAN_REPO_INTERNAL;
    }
    if (!conan_repo) {
      throw new Error(`No upload Conan repository set`);
    }

    // Conan upload
    await upload_pkg(name, version, args, conan_repo);
    await upload_pkg(`${name}-dbg`, version, args, conan_repo);
  } catch (error) {
    core.debug(inspect(error));
    core.setFailed(error.message);
  }
}

async function post(): Promise<void> {
  try {
    await exec(`conan remove --locks`);
    await exec(`conan remove * -f`);
  } catch (error) {
    core.warning(error.message);
  }
}

// Main
if (!process.env["STATE_isPost"]) {
  run();
} // Post
else {
  post();
}
