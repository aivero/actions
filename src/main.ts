import * as core from "@actions/core";
import * as github from "@actions/github";
import { RequestParameters } from "@octokit/types";
import simpleGit, { SimpleGit } from "simple-git";
import { inspect } from "util";
import YAML from "yaml";
import fs from "fs";
import * as path from "path";
import hash from "object-hash";

const CONFIG_NAME = "devops.yml";

class DispatchConfig {
}

class ConanDispatchConfig extends DispatchConfig {
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

class Payload {
    tags?: [string];
    image?: string;
}


class ConanPayload extends Payload {
    package?: string;
    profile?: string;
    args?: string;
    path?: string;
}

interface Event extends RequestParameters {
    owner: string,
    repo: string,
    event_type: string,
    client_payload: Payload,
}


interface Mode {
    get_events(): Promise<Set<Event>>,
}

class ConanMode implements Mode {
  subdir: string;
  args: string;
  repo: string;

  constructor(inputs) {
    this.subdir = inputs.subdir;
    this.args = inputs.arguments;
    this.repo = inputs.repository;
  }

  async load_config_file(conf_path: string): Promise<Set<ConanDispatchConfig>> {
    const name = path.basename(path.dirname(conf_path));
    const conf_raw = fs.readFileSync(conf_path, "utf8");
    return this.set_default_config_values(name, conf_raw)
  }

  async set_default_config_values(name: string, conf_raw: string): Promise<Set<ConanDispatchConfig>> {
    const conf = YAML.parse(conf_raw) as [ConanDispatchConfig];
    const disps = new Set<ConanDispatchConfig>();
    conf.forEach((disp) => {
      // Name
      if (disp.name == undefined) {
        disp.name = name;
      }

      // Default folder
      const folder = ".";
      if (disp.folder == undefined) {
        disp.folder = folder;
      }

      // Default profiles
      const profiles = [
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

  async find_dispatches(): Promise<Set<ConanDispatchConfig>> {
      throw Error("Not implemented!");
  }

  async get_events(): Promise<Set<Event>> {
    const events = new Set<Event>();

    const disps = await this.find_dispatches();
    
    disps.forEach((disp) => {
      // Arguments
      let args = this.args;
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

      // Get build combinations
      if (disp.profiles == undefined) {
          return;
      }
      disp.profiles.forEach((profile) => {
        let image = "aivero/conan:";
        let tags;

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
          tags = ["X64"];
        } else if (profile.includes("armv8")) {
          image += "-armv8";
          tags = ["ARM6"];
        }

        // Handle bootstrap packages
        if (disp.image && disp.image.bootstrap) {
          image += "-bootstrap";
        }

        // Create payload
        const payload = new ConanPayload();
        payload.package = `${disp.name}/${disp.version}`;
        payload.profile = profile;
        payload.path = path.join(this.subdir, disp.name as string, disp.folder as string);
        payload.args = args;
        payload.image = image;
        payload.tags = tags;

        // Create event
        const [owner, repo] = this.repo.split("/");
        const event_type = `${disp.name}/${disp.version}: ${profile}`;
        const client_payload = payload;
        const event: Event = {
           owner,
           repo,
           event_type,
           client_payload
        };
        events.add(event)
      });
    });
    return events;    
  }
}

class ConanGitMode extends ConanMode {
  rev: string;
  git: SimpleGit;
  repo_path: string;

  constructor(inputs) {
    super(inputs)
    this.rev = "HEAD^";
    this.repo_path = inputs.repo_path || "";
    this.git = simpleGit(inputs.repo_path);
  }

  async find_config(dir: string): Promise<string> {
    const dir_ori = dir;
    while (dir != this.subdir) {
      const conf_path = path.join(dir, CONFIG_NAME);
      if (fs.existsSync(conf_path)) {
        return conf_path;
      }
      dir = path.dirname(dir);
    }
    throw Error(`Couldn't find ${CONFIG_NAME} for file: ${dir_ori}`);
  }

  async find_dispatches(): Promise<Set<ConanDispatchConfig>> {
    const disps = new Set<ConanDispatchConfig>();
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

      const file = path.basename(file_path);
      const file_dir = path.dirname(file_path);
      const conf_path = await this.find_config(file_dir);
      const name = path.basename(path.dirname(conf_path));

      let disps_new: Set<ConanDispatchConfig>;
      if (file == CONFIG_NAME) {
        disps_new = await this.handle_config_change(name, file_path);
      } else {
        disps_new = await this.handle_file_change(name, conf_path, file_path);
      }
      disps_new.forEach(disps.add, disps);
    }
    return disps;
  }

  async handle_config_change(name: string, conf_path: string): Promise<Set<ConanDispatchConfig>> {
    // New config.yml
    const conf_new = await this.set_default_config_values(name, await this.git.show([`HEAD:${conf_path}`]));
    const files_old = await this.git.raw(["ls-tree", "-r", this.rev]);
    if (!files_old.includes(conf_path)) {
      core.info(`Created: ${conf_path}`);
      conf_new.forEach((disp) => {
        const disp_hash = hash(disp);
        core.info(
          `Dispatch name/version (hash): ${disp.name}/${disp.version} (${disp_hash})`,
        );
      });
      return conf_new;
    }
    // Compare to old config.yml
    core.info(`Changed: ${conf_path}`);
    const disps = new Set<ConanDispatchConfig>();
    const conf_old = await this.set_default_config_values(name, await this.git.show([`${this.rev}:${conf_path}`]));
    conf_new.forEach((disp_new) => {
      // Check if dispatch existed in old commit or if dispatch data changed
      if (!conf_old.has(disp_new)) {
        const disp_hash = hash(disp_new);
        core.info(
          `Dispatch name/version (hash): ${disp_new.name}/${disp_new.version} (${disp_hash})`,
        );
        disps.add(disp_new);
      }
    });
    return disps;
  }

  async handle_file_change(name: string, conf_path: string, file_path: string): Promise<Set<ConanDispatchConfig>> {
    const disps = new Set<ConanDispatchConfig>();
    const conf_raw = await this.git.show([`HEAD:${conf_path}`]);
    const conf = await this.set_default_config_values(name, conf_raw);
    conf.forEach((disp) => {
      if (file_path.startsWith(path.join(this.subdir, name, disp.folder as string))) {
        const disp_hash = hash(disp);
        core.info(
          `Dispatch name/version (hash): ${disp.name}/${disp.version} (${disp_hash})`,
        );
        disps.add(disp);
      }
    });
    return disps;
  }
}

class ConanManualMode extends ConanMode {
  pkg: string;

  constructor(inputs) {
    super(inputs);
    this.pkg = inputs.package;
  }

  async find_dispatches(): Promise<Set<ConanDispatchConfig>> {
    const disps = new Set<ConanDispatchConfig>();
    const [name, version] = this.pkg.split("/");

    const conf_path = path.join(this.subdir, name, CONFIG_NAME);
    const conf = await this.load_config_file(conf_path);

    conf.forEach((disp) => {
      if (version != "*" && version != disp.version) {
        return;
      }
      const pkg_hash = hash(disp);
      core.info(
        `Build pkg/ver (hash): ${disp.name}/${disp.version} (${pkg_hash})`,
      );
      disps.add(disp);
    });
    return disps;
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

    let mode: Mode;
    if (inputs.mode == "conan_git") {
      core.startGroup("Conan Git Mode: Create dispatches from changed files in git");
      mode = new ConanGitMode(inputs);
    } else if (inputs.mode == "conan_manual") {
      core.startGroup("Conan Manual Mode: Create dispatches from manual input");
      mode = new ConanManualMode(inputs);
    } else {
      throw new Error(`Mode not supported: ${inputs.mode}`);
    }
    const events = await mode.get_events();
    core.endGroup();

    // Dispatch build for each build hash
    core.startGroup("Dispatch Events");
    const octokit = github.getOctokit(inputs.token);
    events.forEach(async (event) => {
      core.info(`${inspect(event.client_payload)}`);
      await octokit.repos.createDispatchEvent(event);
    });
    core.endGroup();
  } catch (error) {
    core.debug(inspect(error));
    core.setFailed(error.message);
  }
}

run();