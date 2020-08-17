import fs, {mkdirSync} from "fs";
import process from "process";
import {initBLS} from "@chainsafe/bls";
import {BeaconNode} from "@chainsafe/lodestar/lib/node";
import {createNodeJsLibp2p} from "@chainsafe/lodestar/lib/network/nodejs";
import {WinstonLogger} from "@chainsafe/lodestar-utils";
import {createEnr, createPeerId} from "../../network";
import {IGlobalArgs} from "../../options";
import rimraf from "rimraf";
import {join} from "path";
import {IDevArgs} from "./options";
import {getInteropValidator} from "../validator/utils/interop/validator";
import {Validator} from "@chainsafe/lodestar-validator/lib";
import {initDevChain, storeSSZState} from "@chainsafe/lodestar/lib/node/utils/state";
import {getValidatorApiClient} from "./utils/validator";
import {mergeConfigOptions} from "../../config/beacon";
import {getBeaconConfig} from "../../util";
import {getBeaconPaths} from "../beacon/paths";
import {IDiscv5DiscoveryInputOptions} from "@chainsafe/discv5";

/**
 * Run a beacon node
 */
export async function devHandler(options: IDevArgs & IGlobalArgs): Promise<void> {
  await initBLS();

  options = mergeConfigOptions(options);
  const peerId = await createPeerId();
  if (!options.network.discv5) options.network.discv5 = {} as IDiscv5DiscoveryInputOptions;
  options.network.discv5.enr = await createEnr(peerId);
  const beaconPaths = getBeaconPaths(options);
  options = {...options, ...beaconPaths};
  const config = getBeaconConfig(options.preset, options.params);
  const libp2p = await createNodeJsLibp2p(peerId, options.network);
  const logger = new WinstonLogger();

  const chainDir = join(options.rootDir, "dev", "beacon");
  const validatorsDir = join(options.rootDir, "dev", "validators");
  mkdirSync(chainDir, {recursive: true});
  mkdirSync(validatorsDir, {recursive: true});

  options.db.name = join(chainDir, "db-" + peerId.toB58String());

  const node = new BeaconNode(options, {
    config,
    libp2p,
    logger,
  });

  if(options.genesisValidators) {
    const state = await initDevChain(node, options.genesisValidators);
    storeSSZState(node.config, state, join(options.rootDir, "dev", "genesis.ssz"));
  }else if (options.genesisStateFile) {
    await node.chain.initializeBeaconChain(
      config.types.BeaconState.tree.deserialize(
        await fs.promises.readFile(
          join(options.rootDir, options.genesisStateFile)
        )
      )
    );
  }

  await node.start();

  let validators: Validator[];
  if(options.startValidators) {
    const range = options.startValidators.split(":").map(s => parseInt(s));
    const api = getValidatorApiClient(options.server, logger, node);
    validators = Array.from(
      {length:range[1] + range[0]},(v,i)=>i+range[0]
    ).map((index) => {
      return getInteropValidator(
        node.config,
        validatorsDir,
        {
          api,
          logger,
        },
        index
      );
    });
    validators.forEach((v) => v.start());
  }

  async function cleanup(): Promise<void> {
    logger.info("Stopping validators");
    await Promise.all(validators.map((v) => v.stop()));
    logger.info("Stopping BN");
    await node.stop();
    if(options.reset) {
      logger.info("Cleaning directories");
      //delete db directory
      rimraf.sync(chainDir);
      rimraf.sync(validatorsDir);
    }
    logger.info("Cleanup completed");
  }

  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
}