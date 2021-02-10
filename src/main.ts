import * as core from "@actions/core";
import * as github from "@actions/github";
import { RequestParameters } from "@octokit/types";
import simpleGit, { SimpleGit } from "simple-git";
import { inspect } from "util";
import YAML from "yaml";
import fs from "fs";
import * as path from "path";
import hash from "object-hash";
import { parse, createVisitor } from 'python-ast';

const CONFIG_NAME = "devops.yml";

interface Inputs {
  token: string;
  repository: string;
  mode: string;
  component: string;
  arguments: string;
}

interface Instance {
  name: string;
  version: string;
  commit: string;
  branch: string;
  folder: string;
  cmdsPre?: string[];
  cmds?: string[];
  cmdsPost?: string[];
  image?: string;
  tags?: string[];
  mode: SelectMode;
}

interface ConanInstance extends Instance {
  profiles: string[];
  settings?: { string };
  options?: { string };
  bootstrap?: boolean;
}

enum SelectMode {
  Conan = "conan",
  Docker = "docker",
  Command = "command",
}

interface Payload {
  tags?: string[];
  image?: string;
  branch?: string;
  commit: string;
  context: string;
  cmdsPre?: string;
  cmds?: string;
  cmdsPost?: string;
  component?: string;
  folder?: string;
  version?: string;
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
  token: string;
  git: SimpleGit;

  constructor(inputs: Inputs) {
    this.args = inputs.arguments;
    this.repo = inputs.repository;
    this.token = inputs.token;
    this.git = simpleGit();

  }

  async run() {
    const ints = await this.findInstances();
    await this.dispatchInstances(ints);
  }

  async loadConfigFile(confPath: string): Promise<{}[]> {
    const confRaw = fs.readFileSync(confPath, "utf8");
    return this.loadConfig(confPath, confRaw)
  }

  async loadConfig(confPath: string, confRaw: string): Promise<{}[]> {
    const folder = path.dirname(confPath);
    const name = path.basename(folder);
    const conf = YAML.parse(confRaw);
    const ints: {}[] = [];
    // Empty conf file
    if (conf == null) {
      return ints;
    }
    for (let int of conf) {
      // Empty instance
      if (int == null) {
        int = {};
      }

      // Set git branch and commit
      if (int.branch == undefined) {
        int.branch = process.env.GITHUB_REF?.split("/")[2];
      }
      if (int.commit == undefined) {
        int.commit = process.env.GITHUB_SHA;
      }

      // Name
      if (int.name == undefined) {
        int.name = name;
      }

      // Version
      if (int.version == undefined) {
        // Set version to commit
        int.version = int.commit;
      }

      // Default folder
      if (int.folder) {
        int.folder = path.join(folder, int.folder);
      } else {
        int.folder = folder;
      }

      // Load mode
      int.mode = this.getMode(int)

      ints.push(int);
    }

    return ints;
  }

  async findInstances(): Promise<{}[]> {
    throw Error("Not implemented!");
  }

  async getBasePayload(int: Instance): Promise<Payload> {
    return {
      image: "node12",
      context: `${int.name}/${int.version}`,
      branch: int.branch,
      commit: int.commit,
      component: int.name,
      folder: int.folder,
      version: int.version,
    }
  }

  async getConanRepo(int: ConanInstance): Promise<string> {
    const conanfilePath = fs.readFileSync(path.join(int.folder, "conanfile.py"), "utf8");
    const conanfileAst = parse(conanfilePath);
    let license = "";
    createVisitor({
      shouldVisitNextChild: () => license == "",
      visitExpr_stmt: (expr) => {
        // Find and check expressions: "license = <STRING|TUPLE>"
        if (expr.children?.length == 3 && expr.children[1].text == "=" && expr.children[0].text == "license") {
          license = expr.children[2].text
        }
      }
    }).visit(conanfileAst);
    if (license == "") {
      throw Error(`No license in '${conanfilePath}'`);
    }
    let conanRepo = "$CONAN_REPO_PUBLIC";
    if (license.includes("Proprietary")) {
      conanRepo = "$CONAN_REPO_INTERNAL";
    }
    return conanRepo
  }

  async getCommandPayload(int: Instance): Promise<{ [name: string]: Payload }> {
    const payloads: { [name: string]: Payload } = {};
    const eventName = `${int.name}/${int.version}`;
    payloads[eventName] = await this.getBasePayload(int);
    return payloads;
  }

  async getConanPayload(int: ConanInstance): Promise<{ [name: string]: Payload }> {
    const payloads: { [name: string]: Payload } = {};

    // Default profiles
    const profiles = [
      "Linux-x86_64",
      "Linux-armv8",
    ];
    if (int.profiles == undefined) {
      int.profiles = profiles;
    }

    // Create instance for each profile
    for (const profile of int.profiles) {
      const payload = await this.getBasePayload(int);

      // Base Conan image
      payload.image = "aivero/conan:";

      // OS options
      if (profile.includes("musl")) {
        payload.image += "alpine";
      } else if (profile.includes("Linux") || profile.includes("Wasi")) {
        payload.image += "bionic";
      } else if (profile.includes("Windows")) {
        payload.image += "windows";
      } else if (profile.includes("Macos")) {
        payload.image += "macos";
      }

      // Arch options
      if (profile.includes("x86_64") || profile.includes("wasm")) {
        payload.image += "-x86_64";
        payload.tags = ["X64"];
      } else if (profile.includes("armv8")) {
        payload.image += "-armv8";
        payload.tags = ["ARM64"];
      }

      // Handle bootstrap packages
      if (int.bootstrap) {
        payload.image += "-bootstrap";
      }

      // Settings
      let args = this.args;
      if (int.settings) {
        for (const [set, val] of Object.entries(int.settings)) {
          args += ` -s ${int.name}:${set}=${val}`;
        }
      }
      // Options
      if (int.options) {
        for (const [opt, val] of Object.entries(int.options)) {
          // Convert to Python bool
          const res = val == true ? "True"
            : val == false ? "False"
              : val;
          args += ` -o ${int.name}:${opt}=${res}`;
        }
      }

      // Check if package is proprietary
      const conanRepo = await this.getConanRepo(int)

      let cmdsPre = int.cmdsPre || [];
      cmdsPre = cmdsPre.concat([
        `conan config install $CONAN_CONFIG_URL -sf $CONAN_CONFIG_DIR`,
        `conan user $CONAN_LOGIN_USERNAME -p $CONAN_LOGIN_PASSWORD -r $CONAN_REPO_ALL`,
        `conan user $CONAN_LOGIN_USERNAME -p $CONAN_LOGIN_PASSWORD -r $CONAN_REPO_INTERNAL`,
        `conan user $CONAN_LOGIN_USERNAME -p $CONAN_LOGIN_PASSWORD -r $CONAN_REPO_PUBLIC`,
        `conan config set general.default_profile=${profile}`,
      ]);
      payload.cmdsPre = JSON.stringify(cmdsPre)

      let cmds = int.cmds || [];
      cmds = cmds.concat([
        `conan create ${args}${int.folder} ${int.name}/${int.version}@`,
        `conan create ${args}${int.folder} ${int.name}-dbg/${int.version}@`,
        `conan upload ${int.name}/${int.version}@ --all -c -r ${conanRepo}`,
        `conan upload ${int.name}-dbg/${int.version}@ --all -c -r ${conanRepo}`,
      ]);
      // Create branch alias for sha commit version
      let version = int.version
      if (int.version?.match("^[0-9a-f]{40}$")) {
        cmds.push(`conan upload ${int.name}/${int.branch}@ --all -c -r ${conanRepo}`)
        version = int.branch
      }
      payload.cmds = JSON.stringify(cmds)

      const cmdsPost = int.cmdsPost || [];
      payload.cmdsPost = JSON.stringify(cmdsPost.concat([
        `conan remove --locks`,
        `conan remove * -f`,
      ]));

      const eventName = `${int.name}/${version}: ${profile}`;
      payload.context = `${eventName} (${hash(payload)})`
      payloads[eventName] = payload;
    }
    return payloads;
  }

  async dispatchInstances(ints: {}[]) {
    core.startGroup("Dispatch instances");

    const [owner, repo] = this.repo.split("/");
    const octokit = github.getOctokit(this.token);

    let payloads: { [name: string]: Payload } = {};
    for (const int of ints) {
      const mode = this.getMode(int as Instance);
      switch (mode) {
        case SelectMode.Conan:
          payloads = await this.getConanPayload(int as ConanInstance);
          break;
        case SelectMode.Command:
          payloads = await this.getCommandPayload(int as Instance);
          break;
        default:
          throw Error(`Mode '${mode}' is not supported yet.`);
      }

      for (const [event_type, client_payload] of Object.entries(payloads)) {
        const event: Event = {
          owner,
          repo,
          event_type,
          client_payload
        };
        core.info(`${inspect(event.client_payload)}`);
        await octokit.repos.createDispatchEvent(event);
        const status = {
          owner,
          repo,
          sha: client_payload.commit,
          state: "pending" as "pending",
          context: client_payload.context,
        }
        await octokit.repos.createCommitStatus(status);
      }
    }
    core.endGroup();
  }

  getMode(int: Instance): SelectMode {
    if (fs.existsSync(path.join(int.folder as string, "conanfile.py"))) {
      return SelectMode.Conan;
    } else if (fs.existsSync(path.join(int.folder as string, "Dockerfile"))) {
      return SelectMode.Docker;
    } else if (int.cmds) {
      return SelectMode.Command;
    }
    // TODO: add support for other modes
    // TODO: Allow specifying a mode manually.
    throw Error(`Could not detect mode for folder: ${int.folder}`);
  }
}

class GitMode extends Mode {
  lastRev: string;

  constructor(inputs: Inputs) {
    super(inputs)
    this.lastRev = process.env.GITHUB_LAST_REV || "HEAD^";
  }

  async findConfig(dir: string): Promise<string | undefined> {
    while (dir != ".") {
      const confPath = path.join(dir, CONFIG_NAME);
      if (fs.existsSync(confPath)) {
        return confPath;
      }
      dir = path.dirname(dir);
    }
    return undefined;
  }

  async findInstances(): Promise<{}[]> {
    core.startGroup("Git Mode: Create instances from changed files in git");
    const ints: {}[] = [];
    const intsHash = new Set<string>();
    // Compare to previous commit
    const diff = await this.git.diffSummary(["HEAD", this.lastRev]);
    for (const d of diff.files) {
      let filePath = d.file;
      // Handle file renaming
      if (filePath.includes(" => ")) {
        core.info(`Renamed: ${filePath} `);
        filePath = filePath.replace(/{(.*) => .*}/, "$1");
      }

      // Only handle files that exist in current commit
      if (!fs.existsSync(filePath)) {
        continue;
      }

      const file = path.basename(filePath);
      const fileDir = path.dirname(filePath);
      const confPath = await this.findConfig(fileDir);
      if (!confPath) {
        core.info(`Couldn't find ${CONFIG_NAME} for file: ${file}`);
        continue;
      }

      let intsNew: {}[];
      if (file == CONFIG_NAME) {
        intsNew = await this.handleConfigChange(filePath);
      } else {
        intsNew = await this.handleFileChange(confPath, filePath);
      }
      for (const int of intsNew) {
        const intHash = hash(int);
        if (!intsHash.has(intHash)) {
          intsHash.add(intHash);
          ints.push(int);
        }
      }
    }
    core.endGroup()
    return ints;
  }

  async handleConfigChange(confPath: string): Promise<{}[]> {
    // New config.yml
    const confNew = await this.loadConfig(confPath, await this.git.show([`HEAD:${confPath}`]));
    const filesOld = await this.git.raw(["ls-tree", "-r", this.lastRev]);
    if (!filesOld.includes(confPath)) {
      core.info(`Created: ${confPath}`);
      for (const int of confNew) {
        const intHash = hash(int);
        const { name, version } = int as Instance;
        core.info(
          `Instance name/version (hash): ${name}/${version} (${intHash})`,
        );
      }
      return confNew;
    }
    // Compare to old config.yml
    core.info(`Changed: ${confPath}`);
    const ints: {}[] = [];
    const confOld = await this.loadConfig(confPath, await this.git.show([`${this.lastRev}:${confPath}`]));
    const hashsOld = [...confOld].map(int => hash(int));
    for (const intNew of confNew) {
      // Check if instance existed in old commit or if instance data changed
      if (!hashsOld.includes(hash(intNew))) {
        const intHash = hash(intNew);
        const { name, version } = intNew as Instance;
        core.info(
          `Instance name/version (hash): ${name}/${version} (${intHash})`,
        );
        ints.push(intNew);
      }
    }
    return ints;
  }

  async handleFileChange(confPath: string, filePath: string): Promise<{}[]> {
    const ints: {}[] = [];
    const conf = await this.loadConfigFile(confPath);
    for (const int of conf) {
      const { name, version, folder } = int as Instance;
      if (path.join(folder).endsWith(path.dirname(filePath))) {
        const intHash = hash(int);
        core.info(
          `Instance name/version (hash): ${name}/${version} (${intHash})`,
        );
        ints.push(int);
      }
    }
    return ints;
  }
}

class ManualMode extends Mode {
  component: string;

  constructor(inputs: Inputs) {
    super(inputs);
    this.component = inputs.component;
  }

  async findInstances(): Promise<{}[]> {
    core.startGroup("Manual Mode: Create instances from manual input");
    const ints: {}[] = [];
    const [inputName, inputVersion] = this.component.split("/");

    const confPaths = (await this.git.raw(["ls-files", "**/devops.yml"])).trim().split("\n");

    for (const confPath of confPaths) {
      const confInts = await this.loadConfigFile(confPath);
      for (const int of confInts) {
        const { name, version } = int as Instance;
        if (inputName != "*" && inputName != name ||
          inputVersion != "*" && inputVersion != version) {
          continue;
        }
        const intHash = hash(ints);
        core.info(
          `Build component/version (hash): ${name}/${version} (${intHash})`,
        );
        ints.push(int);
      }
    }
    core.endGroup()
    return ints;
  }
}

class AliasMode extends Mode {
  constructor(inputs: Inputs) {
    super(inputs);
  }

  async findInstances(): Promise<{}[]> {
    core.startGroup("Alias Mode: Create alias for all package");
    const ints: {}[] = [];

    const confPaths = (await this.git.raw(["ls-files", "**/devops.yml"])).trim().split("\n");

    for (const confPath of confPaths) {
      const confInts = await this.loadConfigFile(confPath);
      for (const int of confInts) {
        const { name, version } = int as Instance;
        // Only create alias for component with commit sha as version
        if (!version?.match("^[0-9a-f]{40}$")) {
          continue
        }
        const intHash = hash(ints);
        core.info(
          `Alias component/version (hash): ${name}/${version} (${intHash})`,
        );
        ints.push(int);
      }
    }
    core.endGroup()
    return ints;
  }

  async dispatchInstances(ints: {}[]) {
    core.startGroup("Dispatch instances");

    const [owner, repo] = this.repo.split("/");
    const octokit = github.getOctokit(this.token);

    const cmdsPre = [
      `conan config install $CONAN_CONFIG_URL -sf $CONAN_CONFIG_DIR`,
      `conan user $CONAN_LOGIN_USERNAME -p $CONAN_LOGIN_PASSWORD -r $CONAN_REPO_ALL`,
      `conan user $CONAN_LOGIN_USERNAME -p $CONAN_LOGIN_PASSWORD -r $CONAN_REPO_INTERNAL`,
      `conan user $CONAN_LOGIN_USERNAME -p $CONAN_LOGIN_PASSWORD -r $CONAN_REPO_PUBLIC`,
    ];
    const cmds: string[] = [];
    for (const int of ints) {
      const { name, version, branch } = int as ConanInstance;
      const conanRepo = await this.getConanRepo(int as ConanInstance)
      // Create branch alias for sha commit versions
      if (version.match("^[0-9a-f]{40}$")) {
        cmds.push(`conan alias ${name}/${version} ${name}/${branch}`)
        cmds.push(`conan upload ${name}/${branch}@ --all -c -r ${conanRepo}`)
      }
    }
    const  client_payload: Payload = {
      image: "aivero/conan:bionic-x86_64",
      tags: ["X64"],
      cmdsPre: JSON.stringify(cmdsPre),
      cmds: JSON.stringify(cmds),
      commit: "",
      context: "Alias: */*",
    };
    const event: Event = {
      owner,
      repo,
      event_type: "Create branch alias for all Conan packages",
      client_payload
    };
    core.info(`${inspect(event.client_payload)}`);
    await octokit.repos.createDispatchEvent(event);
    core.endGroup();
  }
}

async function run(): Promise<void> {
  try {
    // Handle inputs
    const inputs: Inputs = {
      token: core.getInput("token"),
      repository: core.getInput("repository"),
      mode: core.getInput("mode"),
      component: core.getInput("component"),
      arguments: core.getInput("arguments"),
    };
    core.startGroup("Inputs");
    core.info(`Inputs: ${inspect(inputs)}`);
    core.endGroup();

    let mode: Mode;
    if (inputs.mode == "" || inputs.mode == "git") {
      mode = new GitMode(inputs);
    } else if (inputs.mode == "manual") {
      mode = new ManualMode(inputs);
    } else if (inputs.mode == "alias") {
      mode = new AliasMode(inputs);
    } else {
      throw Error(`Unsupported mode: ${inputs.mode}`)
    }
    await mode.run();

  } catch (error) {
    core.debug(inspect(error));
    core.setFailed(error.message);
  }
}

run();
