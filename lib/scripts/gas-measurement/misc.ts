import { pick } from 'lodash';
import { ethers } from 'hardhat';
import { BigNumber, Contract } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';

import { fp } from '../../helpers/numbers';
import { deploy } from '../../helpers/deploy';
import { toNormalizedWeights } from '../../helpers/weights';
import { MAX_UINT256 } from '../../helpers/constants';
import { encodeJoinStablePool } from '../../helpers/stablePoolEncoding';
import { encodeJoinWeightedPool } from '../../helpers/weightedPoolEncoding';
import { bn } from '../../helpers/numbers';
import { deployPoolFromFactory, PoolName } from '../../helpers/pools';
import { deploySortedTokens, mintTokens, TokenList } from '../../helpers/tokens';
import { advanceTime, MONTH } from '../../helpers/time';
import { contracts } from './contracts';

export const tokenSymbols = ['AAA', 'BBB', 'CCC']; //, 'DDD', 'EEE', 'FFF', 'GGG', 'HHH'];

export async function setupEnvironment(): Promise<{
  vault: Contract;
  tokens: TokenList;
  trader: SignerWithAddress;
}> {
  const { deployer, admin, creator, trader } = await getSigners();

  console.log('deployer', deployer.address);
  console.log('admin', admin.address);
  console.log('creator', creator.address);
  console.log('trader', trader.address);

  /*const weth = await deploy('WETH', { args: [admin.address] });
  const authorizer = await deploy('Authorizer', { args: [admin.address] });
  const vault = await deploy('Vault', { args: [authorizer.address, weth.address, 0, 0] });*/

  const authorizer = (await ethers.getContractFactory('Authorizer', admin)).attach(contracts.authorizer);
  const weth = (await ethers.getContractFactory('WETH', admin)).attach(contracts.weth);
  const vault = (await ethers.getContractFactory('Vault', admin)).attach(contracts.vault);

  const tokens = await deploySortedTokens(tokenSymbols, Array(tokenSymbols.length).fill(18));

  const symbols = Object.keys(tokens);
  const tokenAddresses = symbols.map((symbol) => tokens[symbol].address);

  for (const symbol in tokens) {
    // creator tokens are used to initialize pools, but tokens are only minted when required
    await tokens[symbol].connect(creator).approve(vault.address, MAX_UINT256);

    // trader tokens are used to trade and not have non-zero balances
    await mintTokens(tokens, symbol, trader, 200e18);
    await tokens[symbol].connect(trader).approve(vault.address, MAX_UINT256);
  }

  // deposit internal balance for trader to make it non-zero
  const transfers = [];

  for (let idx = 0; idx < tokenAddresses.length; ++idx) {
    transfers.push({
      kind: 0, // deposit
      asset: tokenAddresses[idx],
      amount: bn(100e18),
      sender: trader.address,
      recipient: trader.address,
    });
  }

  await vault.connect(trader).manageUserBalance(transfers);

  return { vault, tokens, trader };
}

export async function deployPool(vault: Contract, tokens: TokenList, poolName: PoolName): Promise<string> {
  const { creator } = await getSigners();

  const symbols = Object.keys(tokens);

  const initialPoolBalance = bn(100e18);
  for (const symbol of symbols) {
    await mintTokens(tokens, symbol, creator, initialPoolBalance);
  }

  const tokenAddresses = symbols.map((symbol) => tokens[symbol].address);
  const swapFeePercentage = fp(0.02); // 2%

  let pool: Contract;
  let joinUserData: string;

  if (poolName == 'WeightedPool' || poolName == 'WeightedPool2Tokens') {
    const weights = toNormalizedWeights(symbols.map(() => fp(1))); // Equal weights for all tokens

    const commonParams = [tokenAddresses, weights, swapFeePercentage];
    pool = await deployPoolFromFactory(vault, poolName, {
      from: creator,
      parameters: poolName == 'WeightedPool2Tokens' ? [...commonParams, true] : [...commonParams],
    });

    joinUserData = encodeJoinWeightedPool({ kind: 'Init', amountsIn: tokenAddresses.map(() => initialPoolBalance) });
  } else if (poolName == 'StablePool') {
    const amplificationParameter = bn(50e18);

    pool = await deployPoolFromFactory(vault, poolName, {
      from: creator,
      parameters: [tokenAddresses, amplificationParameter, swapFeePercentage],
    });

    joinUserData = encodeJoinStablePool({ kind: 'Init', amountsIn: tokenAddresses.map(() => initialPoolBalance) });
  } else {
    throw new Error(`Unhandled pool: ${poolName}`);
  }

  const poolId = await pool.getPoolId();

  await vault.connect(creator).joinPool(poolId, creator.address, creator.address, {
    assets: tokenAddresses,
    maxAmountsIn: tokenAddresses.map(() => initialPoolBalance), // These end up being the actual join amounts
    fromInternalBalance: false,
    userData: joinUserData,
  });

  // Force test to skip pause window
  await advanceTime(MONTH * 5);

  return poolId;
}

export async function getWeightedPool(
  vault: Contract,
  tokens: TokenList,
  size: number,
  offset?: number
): Promise<string> {
  return size === 2
    ? deployPool(vault, pickTokens(tokens, size, offset), 'WeightedPool2Tokens')
    : deployPool(vault, pickTokens(tokens, size, offset), 'WeightedPool');
}

export async function getStablePool(
  vault: Contract,
  tokens: TokenList,
  size: number,
  offset?: number
): Promise<string> {
  return deployPool(vault, pickTokens(tokens, size, offset), 'StablePool');
}

function pickTokens(tokens: TokenList, size: number, offset?: number): TokenList {
  return pick(tokens, tokenSymbols.slice(offset ?? 0, size + (offset ?? 0)));
}

export function pickTokenAddresses(tokens: TokenList, size: number, offset?: number): string[] {
  return tokenSymbols.slice(offset ?? 0, size + (offset ?? 0)).map((symbol) => tokens[symbol].address);
}

export async function getSigners(): Promise<{
  deployer: SignerWithAddress;
  admin: SignerWithAddress;
  creator: SignerWithAddress;
  trader: SignerWithAddress;
}> {
  const [deployer, admin, creator, trader] = await ethers.getSigners();

  return { deployer, admin, creator, trader };
}

export function printGas(gas: number | BigNumber): string {
  if (typeof gas !== 'number') {
    gas = gas.toNumber();
  }

  return `${(gas / 1000).toFixed(1)}k`;
}
