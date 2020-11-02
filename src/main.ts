import * as core from "@actions/core";
import * as github from "@actions/github";
import simpleGit, { SimpleGit } from "simple-git";
import { inspect } from "util";
import YAML from "yaml";
import fs from "fs";
import * as path from "path";
import hash from "object-hash";

const CONFIG_NAME = "config.yml";
interface ConanConfig {
  name?: string;
  version?: string;
  folder?: string;
  profiles?: string[];
  settings?: {};
  options?: {};
  image?: ImageConfig;
}
interface ImageConfig {
  bootstrap?: boolean;
}


class ConanMode {
  subdir: string;

  constructor(subdir) {
    this.subdir = subdir;
  }

  async load_config_file(conf_path): Promise<Set<ConanConfig>> {
    const name = path.basename(path.dirname(conf_path));
    const conf_raw = fs.readFileSync(conf_path, "utf8");
    return this.set_default_config(name, conf_raw)
  }

  async set_default_config(name, conf_raw): Promise<Set<ConanConfig>> {
    let conf = YAML.parse(conf_raw) as [ConanConfig];
    let disps = new Set<ConanConfig>();
    conf.forEach((disp) => {
      // Name
      if (disp.name == undefined) {
        disp.name = name;
      }

      // Default folder
      let folder = "all";
      if (disp.folder == undefined) {
        disp.folder = folder;
      }

      // Default profiles
      let profiles = [
        "Linux-x86_64",
        "Linux-armv8",
      ];
      if (disp.profiles == undefined) {
        disp.profiles = profiles;
      }

      if (disp.image == undefined) {
        disp.image = { boostrap: false } as ImageConfig;
      }
      disps.add(disp);
    });

    return disps;
  }

  async get_builder_options(disp: ConanConfig): Promise<{ tags; profile; image }[]> {
    // Get build combinations
    const builder_opts: { tags; profile; image }[] = [];
    if (!disp.profiles) {
      return builder_opts;
    }
    disp.profiles.forEach((profile) => {
      let image = "aivero/conan:";
      let tags = ["x64"];

      // OS options
      if (profile.includes("musl")) {
        image += "alpine";
      } else if (profile.includes("Linux") || profile.includes("Wasi")) {
        image += "bionic";
      } else if (profile.includes("Windows")) {
        image += "windows";
      } else if (profile.includes("Macos")) {
        image += "macos";
      }

      // Arch options
      if (profile.includes("x86_64") || profile.includes("wasm")) {
        image += "-x86_64";
      } else if (profile.includes("armv8")) {
        image += "-armv8";
        tags = ["ARM64"];
      }

      // Handle bootstrap packages
      if (disp.image && disp.image.bootstrap) {
        image += "-bootstrap";
      }

      builder_opts.push({
        tags: tags,
        profile: profile,
        image: image,
      });
    });
    return builder_opts;
  }

}
class ConanGitMode extends ConanMode {
  rev: string;
  git: SimpleGit;
  repo_path: string;
  disps: Set<ConanConfig>;

  constructor(subdir, rev, repo_path = "") {
    super(subdir)
    this.subdir = subdir;
    this.rev = rev;
    this.repo_path = repo_path;
    this.git = simpleGit(repo_path);
    this.disps = new Set<ConanConfig>();
  }

  async find_config(dir): Promise<string> {
    while (dir != this.subdir) {
      let cfg_path = path.join(dir, CONFIG_NAME);
      if (fs.existsSync(cfg_path)) {
        return cfg_path;
      }
      dir = path.dirname(dir);
    }
    return ""
  }

  async find_dispatces(): Promise<Set<ConanConfig>> {
    // Compare to previous commit
    const diff = await this.git.diffSummary(["HEAD", "HEAD^"]);
    for (const f of diff.files) {
      let file_path = f.file;
      // Handle file renaming
      if (file_path.includes(" => ")) {
        core.info(`Renamed: ${file_path}`);
        file_path = file_path.replace(/{(.*) => .*}/, "$1");
      }

      // Only handle files that exist in current commit
      if (!fs.existsSync(path.join(this.repo_path, file_path))) {
        continue;
      }

      //const [root, pkg, conf_or_ver] = file.split("/");
      const file = path.basename(file_path);
      const file_dir = path.dirname(file_path);
      const conf_path = await this.find_config(file_dir);
      const name = path.basename(path.dirname(conf_path));

      if (file == CONFIG_NAME) {
        await this.handle_config_change(name, file_path);
      } else {
        await this.handle_file_change(name, conf_path, file_path);
      }
    }
    return this.disps;
  }

  async handle_config_change(name, conf_path) {
    // New config.yml
    const conf_new = await this.set_default_config(name, await this.git.show([`HEAD:${conf_path}`]));
    const files_old = await this.git.raw(["ls-tree", "-r", this.rev]);
    if (!files_old.includes(conf_path)) {
      core.info(`Created: ${conf_path}`);
      conf_new.forEach((disp) => {
        let disp_hash = hash(disp);
        core.info(
          `Dispatch name/version (hash): ${disp.name}/${disp.version} (${disp_hash})`,
        );
      });
      this.disps = conf_new;
      return;
    }
    // Compare to old config.yml
    core.info(`Changed: ${conf_path}`);
    const conf_old = await this.set_default_config(name, await this.git.show([`${this.rev}:${conf_path}`]));
    conf_new.forEach((disp_new) => {
      // Check if dispatch existed in old commit or if dispatch data changed
      if (!conf_old.has(disp_new)) {
        let disp_hash = hash(disp_new);
        core.info(
          `Dispatch name/version (hash): ${disp_new.name}/${disp_new.version} (${disp_hash})`,
        );
        this.disps.add(disp_new);
      }
    });
  }

  async handle_file_change(name, conf_path, file_path: string) {
    const conf = await this.set_default_config(name, await this.git.show([`HEAD:${conf_path}`]));
    conf.forEach((disp) => {
      if (file_path.startsWith(path.join(this.subdir, name, disp.folder as string))) {
        let disp_hash = hash(disp);
        core.info(
          `Dispatch name/version (hash): ${disp.name}/${disp.version} (${disp_hash})`,
        );
        this.disps.add(disp);
      }
    });
  }
}
class ConanManualMode extends ConanMode {
  disps: Set<ConanConfig>;

  constructor(subdir) {
    super(subdir);
    this.disps = new Set<ConanConfig>();
  }

  async find_dispatces(pkg: string): Promise<Set<ConanConfig>> {
    const [name, version] = pkg.split("/");

    const conf_path = path.join(this.subdir, name, CONFIG_NAME);
    const conf = await this.load_config_file(conf_path);

    conf.forEach((disp) => {
      if (version != "*" && version != disp.version) {
        return;
      }
      let pkg_hash = hash(disp);
      core.info(
        `Build pkg/ver (hash): ${disp.name}/${disp.version} (${pkg_hash})`,
      );
      this.disps.add(disp);
    });

    return this.disps;
  }
}
async function run(): Promise<void> {
  try {
    // Handle inputs
    const inputs = {
      token: core.getInput("token"),
      repository: core.getInput("repository"),
      mode: core.getInput("mode"),
      subdir: core.getInput("subdir"),
      repository_path: core.getInput("repository_path"),
      package: core.getInput("package"),
      arguments: core.getInput("arguments"),
    };
    core.debug(`Inputs: ${inspect(inputs)}`);
    const [owner, repo] = inputs.repository.split("/");
    const octokit = github.getOctokit(inputs.token);

    let disps: Set<ConanConfig>;
    if (inputs.mode == "conan_git") {
      core.startGroup("Conan Git Mode: Create dispatches from changed files in git");
      let git_mode = new ConanGitMode(inputs.subdir, "^HEAD", inputs.repository_path);
      disps = await git_mode.find_dispatces();
      core.endGroup();
    } else if (inputs.mode == "conan_manual") {
      core.startGroup("Conan Manual Mode: Create dispatches from manual input");
      let manual_mode = new ConanManualMode(inputs.subdir);
      disps = await manual_mode.find_dispatces(inputs.package);
    } else {
      throw new Error(`Mode not supported: ${inputs.mode}`);
    }

    // Dispatch build for each build hash
    disps.forEach(async (disp) => {
      // Arguments
      let args = inputs.arguments;
      if (disp.settings) {
        for (const [set, val] of Object.entries(disp.settings)) {
          args += ` ${disp.name}:${set}=${val}`;
        }
      }
      // Options
      if (disp.options) {
        for (let [opt, val] of Object.entries(disp.options)) {
          // Convert to Python bool
          if (val == true) {
            val = "True";
          }
          if (val == false) {
            val = "False";
          }
          args += ` ${disp.name}:${opt}=${val}`;
        }
      }

      let builder_opts = await get_builder_options(disp);

      let mode_data = {
        package: `${disp.name}/${disp.version}`,
        args: args,
        path: path.join(inputs.subdir, disp.name as string, disp.folder as string),
      }

      // Dispatch Conan events
      core.startGroup("Dispatch Conan Events");
      builder_opts.forEach(async (opt) => {
        const payload = {
          mode: inputs.mode,
          mode_data: mode_data,
          builder_options: opt,
          ref: process.env.GITHUB_REF,
          sha: process.env.GITHUB_SHA,
        };
        core.info(`${inspect(payload)}`);
        //await octokit.repos.createDispatchEvent({
        //  owner: owner,
        //  repo: repo,
        //  event_type: `${disp.name}/${disp.version}: ${opt.profile}`,
        //  client_payload: payload,
        //});
      });
      core.endGroup();
    }
    )
  } catch (error) {
    core.debug(inspect(error));
    core.setFailed(error.message);
  }
}



run();
