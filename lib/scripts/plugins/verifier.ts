import fs from 'fs';
import path, { extname } from 'path';
import fetch, { Response } from 'node-fetch';
import { BuildInfo, CompilationJobCreationErrorReason, CompilerInput, Network } from 'hardhat/types';
import axios, { AxiosResponse } from 'axios';
import { getLongVersion } from '@nomiclabs/hardhat-etherscan/dist/src/solc/version';
import { encodeArguments } from '@nomiclabs/hardhat-etherscan/dist/src/ABIEncoder';
import { getLibraryLinks, Libraries } from '@nomiclabs/hardhat-etherscan/dist/src/solc/libraries';

import {
  Bytecode,
  ContractInformation,
  extractMatchingContractInformation,
} from '@nomiclabs/hardhat-etherscan/dist/src/solc/bytecode';

import { getEtherscanEndpoints, retrieveContractBytecode } from '@nomiclabs/hardhat-etherscan/dist/src/network/prober';

import {
  toVerifyRequest,
  toCheckStatusRequest,
  EtherscanVerifyRequest,
} from '@nomiclabs/hardhat-etherscan/dist/src/etherscan/EtherscanVerifyContractRequest';

import EtherscanResponse, {
  delay,
  getVerificationStatus,
} from '@nomiclabs/hardhat-etherscan/dist/src/etherscan/EtherscanService';

import * as parser from '@solidity-parser/parser';
import { findContractSourceName, getAllFullyQualifiedNames } from './buildinfo';
import { error } from 'console';

const MAX_VERIFICATION_INTENTS = 3;

const logger = {
  info: (args: any) => console.log(...args),
};

export default class Verifier {
  apiKey: string;
  network: Network;

  constructor(_network: Network, _apiKey: string) {
    this.network = _network;
    this.apiKey = _apiKey;
  }

  async call(
    name: string,
    address: string,
    constructorArguments: string | unknown[],
    libraries: Libraries = {},
    intent = 1
  ): Promise<string> {
    const response = await this.verify(name, address, constructorArguments, libraries);

    if (response.isVerificationSuccess()) {
      // const etherscanAPIEndpoints = await getEtherscanEndpoints(
      //   this.network.provider, this.network.name
      //   );
      const etherscanAPIEndpoints = {
        apiURL: 'https://beta-devnet-api.neonscan.org/contract/verify',
        browserURL: 'https://neonscan.org',
      };
      const contractURL = new URL(`/address/${address}#code`, etherscanAPIEndpoints.browserURL);
      return contractURL.toString();
    } else if (intent < MAX_VERIFICATION_INTENTS && response.isBytecodeMissingInNetworkError()) {
      logger.info(`Could not find deployed bytecode in network, retrying ${intent++}/${MAX_VERIFICATION_INTENTS}...`);
      delay(5000);
      return this.call(name, address, constructorArguments, libraries, intent++);
    } else {
      throw new Error(`The contract verification failed. Reason: ${response.message}`);
    }
  }

  async getVerificationParams(name: string, address: string, args: string | unknown[]): Promise<any> {
    const deployedBytecodeHex = await retrieveContractBytecode(address, this.network.provider, this.network.name);
    const deployedBytecode = new Bytecode(deployedBytecodeHex);
    const buildInfos = await this.getBuildInfos();
    const buildInfo = this.findBuildInfoWithContract(buildInfos, name);
    buildInfo.input = this.trimmedBuildInfoInput(name, buildInfo.input);

    const sourceName = findContractSourceName(buildInfo, name);
    const contractInformation = await extractMatchingContractInformation(sourceName, name, buildInfo, deployedBytecode);
    if (!contractInformation) throw Error('Could not find a bytecode matching the requested contract');

    const solcFullVersion = await getLongVersion(contractInformation.solcVersion);

    const deployArgumentsEncoded =
      typeof args == 'string'
        ? args
        : await encodeArguments(
            contractInformation.contract.abi,
            contractInformation.sourceName,
            contractInformation.contractName,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            args as any[]
          );
    const build = buildInfo.input;
    const sources = Object.keys(build.sources).map((name) => [
      name,
      JSON.stringify(build.sources[name].content).replace(`\\n`, '').replace(`\\"`, ''),
    ]);
    return {
      sources,
      name,
      address,
      solcFullVersion,
      sourceName: contractInformation.sourceName,
      contractName: contractInformation.contractName,
      optimizations: {
        enabled: build.settings.optimizer.enabled,
        runs: build.settings.optimizer.runs,
      },
      compilerVersion: solcFullVersion,
      deployArguments: deployArgumentsEncoded,
    };
  }

  getBuildInfo(fileName: string): BuildInfo {
    const buildInfoDir = this._dirAt(this.dir(), 'artifacts/build-info');
    const artifactFile = this._fileAt(buildInfoDir, `${extname(fileName) ? fileName : `${fileName}.json`}`);
    return JSON.parse(fs.readFileSync(artifactFile).toString());
  }

  getBuildInfos(): Array<BuildInfo> {
    const buildInfoDir = this._dirAt(this.dir(), 'artifacts/build-info');
    return fs.readdirSync(buildInfoDir).map((fileName) => this.getBuildInfo(fileName));
  }

  dir(): string {
    return '';
    // The task might be deprecated, so it may not exist in the main directory. We first look there, but don't require
    // that the directory exists.
  }

  private _fileAt(base: string, name: string, ensure = true): string {
    const filePath = path.join(base, name);
    if (ensure && !this._existsFile(filePath)) throw Error(`Could not find a file at ${filePath}`);
    return filePath;
  }

  private _dirAt(base: string, name: string, ensure = true): string {
    const dirPath = path.join(base, name);
    if (ensure && !this._existsDir(dirPath)) throw Error(`Could not find a directory at ${dirPath}`);
    return dirPath;
  }

  private _existsFile(filePath: string): boolean {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  }

  private _existsDir(dirPath: string): boolean {
    return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
  }
  async delay(milliseconds: number): Promise<void> {
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, milliseconds);
    });
  }
  async verify(name: string, address: string, args: string | unknown[], libraries: Libraries = {}): Promise<any> {
    await delay(5000);
    const deployedBytecodeHex = await retrieveContractBytecode(address, this.network.provider, this.network.name);
    const deployedBytecode = new Bytecode(deployedBytecodeHex);
    const buildInfos = await this.getBuildInfos();
    const buildInfo = this.findBuildInfoWithContract(buildInfos, name);
    buildInfo.input = this.trimmedBuildInfoInput(name, buildInfo.input);
    const sourceName = findContractSourceName(buildInfo, name);
    const contractInformation = await extractMatchingContractInformation(sourceName, name, buildInfo, deployedBytecode);
    if (!contractInformation) throw Error('Could not find a bytecode matching the requested contract');
    const { libraryLinks } = await getLibraryLinks(contractInformation, libraries);
    contractInformation.libraryLinks = libraryLinks;
    const deployArgumentsEncoded =
      typeof args == 'string'
        ? args
        : await encodeArguments(
            contractInformation.contract.abi,
            contractInformation.sourceName,
            contractInformation.contractName,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            args as any[]
          );

    const solcFullVersion = await getLongVersion(contractInformation.solcVersion);
    // const etherscanAPIEndpoints = await getEtherscanEndpoints(this.network.provider, this.network.name);
    const etherscanAPIEndpoints = {
      apiURL: 'https://beta-devnet-api.neonscan.org/contract/verify',
      browserURL: 'https://neonscan.org',
    };

    const verificationStatus = await this.attemptVerification(
      etherscanAPIEndpoints,
      contractInformation,
      address,
      this.apiKey,
      buildInfo.input,
      solcFullVersion,
      args
    );

    return verificationStatus;
    // if (verificationStatus.isVerificationSuccess()) return verificationStatus;
    // throw new Error(`The contract verification failed. Reason: ${verificationStatus.message}`);
  }

  private async attemptVerification(
    etherscanAPIEndpoints: any,
    contractInformation: ContractInformation,
    contractAddress: string,
    etherscanAPIKey: string,
    compilerInput: CompilerInput,
    solcFullVersion: string,
    deployArgumentsEncoded: any
  ): Promise<any> {
    compilerInput.settings.libraries = contractInformation.libraryLinks;
    const sources = Object.keys(compilerInput.sources).map((name) => {
      return {
        content: compilerInput.sources[name].content,
        file_name: name,
      };
    });
    const request = {
      contract_address: contractAddress,
      source_code: sources,
      // contract_name: `${contractInformation.sourceName}:${contractInformation.contractName}`,
      contract_name: `${contractInformation.contractName}`,
      version: solcFullVersion,
      args: deployArgumentsEncoded,
      optimization: compilerInput.settings.optimizer.enabled,
      runs: compilerInput.settings.optimizer.runs,
      compiler_type: 'solidity',
    };

    const response = await this.verifyContract(etherscanAPIEndpoints.apiURL, request);
    // const pollRequest = toCheckStatusRequest({ apiKey: etherscanAPIKey, guid: response.message });

    await delay(5000);
    // const verificationStatus = await getVerificationStatus(etherscanAPIEndpoints.apiURL, pollRequest);

    // if (verificationStatus.isVerificationFailure() || verificationStatus.isVerificationSuccess()) {
    //   return verificationStatus;
    // }

    return response;
    // throw new Error(`The API responded with an unexpected message: ${verificationStatus.message}`);
  }

  private async verifyContract(url: string, req: EtherscanVerifyRequest | any): Promise<any> {
    const fs = require('fs');
    fs.writeFileSync(`./${req.contract_name}.json`, JSON.stringify(req));

    let response: AxiosResponse;
    try {
      response = await axios.post(url, req);
    } catch (error: any) {
      console.log(error);
      throw Error(`Failed to send verification request. Reason: ${error.response.data.message}`);
    }

    if (!response.data.success) {
      throw Error(`Failed to send verification request.\nHTTP code: ${response.status}.\nResponse: ${response.data}`);
    } else {
      console.log('Verified!');
    }
    // const etherscanResponse = new EtherscanResponse(await response.json());
    // if (!etherscanResponse.isOk()) throw Error(etherscanResponse.message);
    // return etherscanResponse;
    return response;
  }

  private findBuildInfoWithContract(buildInfos: BuildInfo[], contractName: string): BuildInfo {
    const found = buildInfos.find((buildInfo) =>
      getAllFullyQualifiedNames(buildInfo).some((name) => name.contractName === contractName)
    );

    if (found === undefined) {
      throw Error(`Could not find a build info for contract ${contractName}`);
    } else {
      return found;
    }
  }

  // Trims the inputs of the build info to only keep imported files, avoiding submitting unnecessary source files for
  // verification (e.g. mocks). This is required because Hardhat compiles entire projects at once, resulting in a single
  // huge build info.
  private trimmedBuildInfoInput(contractName: string, input: CompilerInput): CompilerInput {
    // First we find all sources imported from our contract
    const sourceName = this.getContractSourceName(contractName, input);
    const importedSourceNames = this.getContractImportedSourceNames(
      sourceName,
      input,
      new Set<string>().add(sourceName)
    );

    // Then, we keep only those inputs. This method also preserves the order of the files, which may be important in
    // some versions of solc.
    return {
      ...input,
      sources: Object.keys(input.sources)
        .filter((source) => importedSourceNames.has(source))
        .map((source) => ({ [source]: input.sources[source] }))
        .reduce((previous, current) => Object.assign(previous, current), {}),
    };
  }

  private getAbsoluteSourcePath(relativeSourcePath: string, input: CompilerInput): string {
    // We're not actually converting from relative to absolute but rather guessing: we'll extract the filename from the
    // relative path, and then look for a source name in the inputs that matches it.
    const contractName = (relativeSourcePath.match(/.*\/(\w*)\.sol/) as RegExpMatchArray)[1];
    return this.getContractSourceName(contractName, input);
  }

  private getContractSourceName(contractName: string, input: CompilerInput): string {
    const absoluteSourcePath = Object.keys(input.sources).find((absoluteSourcePath) =>
      absoluteSourcePath.includes(`/${contractName}.sol`)
    );

    if (absoluteSourcePath === undefined) {
      throw new Error(`Could not find source name for ${contractName}`);
    }

    return absoluteSourcePath;
  }

  private getContractImportedSourceNames(
    sourceName: string,
    input: CompilerInput,
    previousSourceNames: Set<string>
  ): Set<string> {
    const ast = parser.parse(input.sources[sourceName].content);
    parser.visit(ast, {
      ImportDirective: (node: any) => {
        // Imported paths might be relative, so we convert them to absolute
        const importedSourceName = this.getAbsoluteSourcePath(node.path, input);

        if (!previousSourceNames.has(importedSourceName)) {
          // New source!
          previousSourceNames = this.getContractImportedSourceNames(
            importedSourceName,
            input,
            new Set(previousSourceNames).add(importedSourceName)
          );
        }
      },
    });

    return previousSourceNames;
  }
}
