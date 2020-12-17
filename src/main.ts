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

interface Inputs {
    token: string;
    repository: string;
    root: string;
    package: string;
    arguments: string;
}

interface DispatchConfig {
  name?: string;
  version?: string;
  commit?: string;
  folder?: string;
  profiles?: string[];
  settings?: {string};
  options?: {string};
  image?: ImageConfig;
}

interface ImageConfig {
  bootstrap?: boolean;
}

enum DispatchMode {
    Conan = "Conan",
    Cargo = "Cargo"
}

interface Payload {
    tags?: [string];
    image?: string;
    branch?: string;
    commit?: string;
    mode?: DispatchMode;
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


class Mode {
  args: string;
  repo: string;
  root: string;

  constructor(inputs: Inputs) {
    this.args = inputs.arguments;
    this.repo = inputs.repository;
    this.root = inputs.root;
  }

  async load_config_file(conf_path: string): Promise<Set<DispatchConfig>> {
    const name = path.basename(path.dirname(conf_path));
    const conf_raw = fs.readFileSync(conf_path, "utf8");
    return this.load_config(name, conf_raw)
  }

  async load_config(name: string, conf_raw: string): Promise<Set<DispatchConfig>> {
    const conf = YAML.parse(conf_raw) as [DispatchConfig];
    const disps = new Set<DispatchConfig>();
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

  async find_dispatches(): Promise<Set<DispatchConfig>> {
      throw Error("Not implemented!");
  }

  async get_events(): Promise<Set<Event>> {
    const events = new Set<Event>();

    const disps = await this.find_dispatches();
    
    for (const disp of disps) {
      // Arguments
      let args = this.args;
      if (disp.settings) {
        for (const [set, val] of Object.entries(disp.settings)) {
          args += ` ${disp.name}:${set}=${val}`;
        }
      }
      // Options
      if (disp.options) {
        for (const [opt, val] of Object.entries(disp.options)) {
          // Convert to Python bool
          const res = val == true ? "True"
                    : val == false ? "False"
                    : val;
          args += ` ${disp.name}:${opt}=${res}`;
        }
      }
      args.trim();

      // Get build combinations
      if (disp.profiles == undefined) {
          continue;
      }
      for (const profile of disp.profiles) {
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
          tags = ["ARM64"];
        }

        // Handle bootstrap packages
        if (disp.image && disp.image.bootstrap) {
          image += "-bootstrap";
        }

        // Find branch and commit
        const branch = process.env.GITHUB_REF?.split("/")[2];
        const version = branch == "master" ? disp.version
                      : `${disp.version}-${branch}`;
        const commit = disp.commit ? disp.commit
                      : process.env.GITHUB_SHA;
        
        // Create payload
        const payload: Payload = {
            tags,
            image,
            branch,
            commit,
            mode: await this.get_mode(disp),
            package: `${disp.name}/${version}`,
            profile,
            args,
            path: path.join(this.root, disp.name as string, disp.folder as string),
        }

        // Create event
        const [owner, repo] = this.repo.split("/");
        const event_type = `${disp.name}/${version}: ${profile}`;
        const client_payload = payload;
        const event: Event = {
           owner,
           repo,
           event_type,
           client_payload
        };
        events.add(event)
      }
    }
    return events;    
  }

  async get_mode(disp: DispatchConfig): Promise<DispatchMode> {
    if (fs.existsSync(path.join(this.root, disp.name as string, disp.folder as string, "conanfile.py"))) {
        return DispatchMode.Conan;
    } else if (fs.existsSync(path.join(this.root, disp.name as string, disp.folder as string, "Cargo.toml"))) {
        return DispatchMode.Cargo;
    }
    throw Error(`Could not detect mode for folder: ${disp.folder}`);
  }
}

class GitMode extends Mode {
  last_rev: string;
  git: SimpleGit;

  constructor(inputs: Inputs) {
    super(inputs)
    this.last_rev = process.env.GITHUB_LAST_REV || "HEAD^";
    this.git = simpleGit();
  }

  async find_config(dir: string): Promise<string | undefined> {
    while (dir != ".") {
      const conf_path = path.join(dir, CONFIG_NAME);
      if (fs.existsSync(conf_path)) {
        return conf_path;
      }
      dir = path.dirname(dir);
    }
    return undefined;
  }

  async find_dispatches(): Promise<Set<DispatchConfig>> {
    const disps = new Set<DispatchConfig>();
    const disps_hash = new Set<string>();
    // Compare to previous commit
    const diff = await this.git.diffSummary(["HEAD", this.last_rev]);
    for (const d of diff.files) {
      let file_path = d.file;
      // Handle file renaming
      if (file_path.includes(" => ")) {
        core.info(`Renamed: ${file_path}`);
        file_path = file_path.replace(/{(.*) => .*}/, "$1");
      }

      // Only handle files that exist in current commit
      if (!fs.existsSync(file_path)) {
        continue;
      }

      const file = path.basename(file_path);
      const file_dir = path.dirname(file_path);
      const conf_path = await this.find_config(file_dir);
      if (!conf_path) {
          core.info(`Couldn't find ${CONFIG_NAME} for file: ${file}`);
          continue;
      }
      const name = path.basename(path.dirname(conf_path));

      let disps_new: Set<DispatchConfig>;
      if (file == CONFIG_NAME) {
        disps_new = await this.handle_config_change(name, file_path);
      } else {
        disps_new = await this.handle_file_change(name, conf_path, file_path);
      }
      disps_new.forEach(disp => {
          const disp_hash = hash(disp);
          if (!disps_hash.has(disp_hash)) {
            disps_hash.add(disp_hash);
            disps.add(disp); 
          }
      });
    }
    return disps;
  }

  async handle_config_change(name: string, conf_path: string): Promise<Set<DispatchConfig>> {
    // New config.yml
    const conf_new = await this.load_config(name, await this.git.show([`HEAD:${conf_path}`]));
    const files_old = await this.git.raw(["ls-tree", "-r", this.last_rev]);
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
    const disps = new Set<DispatchConfig>();
    const conf_old = await this.load_config(name, await this.git.show([`${this.last_rev}:${conf_path}`]));
    const hashs_old = [...conf_old].map(disp => hash(disp));
    conf_new.forEach((disp_new) => {
      // Check if dispatch existed in old commit or if dispatch data changed
      if (!hashs_old.includes(hash(disp_new))) {
        const disp_hash = hash(disp_new);
        core.info(
          `Dispatch name/version (hash): ${disp_new.name}/${disp_new.version} (${disp_hash})`,
        );
        disps.add(disp_new);
      }
    });
    return disps;
  }

  async handle_file_change(name: string, conf_path: string, file_path: string): Promise<Set<DispatchConfig>> {
    const disps = new Set<DispatchConfig>();
    const conf = await this.load_config_file(conf_path);
    conf.forEach((disp) => {
      if (path.join(this.root, name, disp.folder as string).endsWith(path.dirname(file_path))) {
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

class ManualMode extends Mode {
  pkg: string;

  constructor(inputs: Inputs) {
    super(inputs);
    this.pkg = inputs.package;
  }

  async find_dispatches(): Promise<Set<DispatchConfig>> {
    const disps = new Set<DispatchConfig>();
    const [name, version] = this.pkg.split("/");

    const conf_path = path.join(this.root, name, CONFIG_NAME);
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
    const inputs: Inputs = {
      token: core.getInput("token"),
      repository: core.getInput("repository"),
      root: core.getInput("root"),
      package: core.getInput("package"),
      arguments: core.getInput("arguments"),
    };
    core.debug(`Inputs: ${inspect(inputs)}`);

    let mode: Mode;
    if (inputs.package) {
      core.startGroup("Manual Mode: Create dispatches from manual input");
      mode = new ManualMode(inputs);
    } else {
      core.startGroup("Git Mode: Create dispatches from changed files in git");
      mode = new GitMode(inputs);
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