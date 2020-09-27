import * as core from "@actions/core";
import { inspect } from "util";
import { spawn } from "child_process";
import * as coreCommand from "@actions/core/lib/command";
import { promisify } from "util";
import path from "path";
import fs from "fs";

function sleep(millis) {
  return new Promise((resolve) => setTimeout(resolve, millis));
}

async function exec(
  full_cmd: string,
  fail_on_error = true,
  return_stdout = false,
) {
  let args = full_cmd.split(" ");
  let cmd = args.shift();
  if (!cmd) {
    throw new Error(`Invalid command: '${full_cmd}'`);
  }
  core.startGroup(`Running command: '${full_cmd}'`);
  const child = await spawn(cmd, args, {});

  let res = "";
  for await (const chunk of child.stdout) {
    core.info(chunk);
    if (return_stdout) {
      res += chunk;
    }
  }
  core.endGroup();

  for await (const chunk of child.stderr) {
    if (fail_on_error) {
      core.error(chunk.toString("utf8"));
    } else {
      core.info(chunk.toString("utf8"));
    }
  }
  const exitCode = await new Promise((resolve, reject) => {
    child.on("close", resolve);
  });

  if (exitCode && fail_on_error) {
    throw new Error(`Command '${full_cmd}' failed with code: ${exitCode}`);
  }
  return res.trim();
}

async function get_pkg_info(name: string, version: string) {
  const file = `/tmp/${name}.json`;
  await exec(`conan info ${name}/${version}@ --paths --json ${file}`);
  const pkg_info_json = fs.readFileSync(file, "utf8");
  return JSON.parse(pkg_info_json);
}

async function upload_pkg(name: string, version: string, repo: string) {
  const info = await get_pkg_info(name, version);
  const pkg_path = info[0].package_folder;
  // Only upload if package is not empty (Empty packages contain 2 files: conaninfo.txt and conanmanifest.txt)
  if (fs.readdirSync(pkg_path).length > 2) {
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
      path: core.getInput("path"),
      profile: core.getInput("profile"),
      conan_repo: core.getInput("conan_repo"),
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
      `conan user ${process.env.CONAN_LOGIN_USERNAME} -p ${process.env.CONAN_LOGIN_PASSWORD} -r ${inputs.conan_repo}`,
    );
    await exec(`conan config set general.default_profile=${inputs.profile}`);

    // Workaround to force fetch source until fixed upstream in Conan: https://github.com/conan-io/conan/issues/3084
    await exec(`rm -rf ${path.join(conan_pkg_path, "source")}`);

    // Check if development package should be build
    const dev_pkg = !fs.readFileSync(
      `${inputs.path}/conanfile.py`,
      { encoding: "utf-8" },
    ).includes("no_dev_pkg = True");

    // Conan Create and Upload
    await exec(`conan create -u ${inputs.path} ${name}/${version}@`);
    await exec(`conan create -u ${inputs.path} ${name}-dbg/${version}@`);
    if (dev_pkg) {
      await exec(`conan create -u ${inputs.path} ${name}-dev/${version}@`);
      await upload_pkg(`${name}-dev`, version, inputs.conan_repo);
    }
    await upload_pkg(name, version, inputs.conan_repo);
    await upload_pkg(`${name}-dbg`, version, inputs.conan_repo);
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
