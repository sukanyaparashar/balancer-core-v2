import { ethers } from 'hardhat';
import { BigNumber, Contract } from 'ethers';
import { Dictionary, fromPairs } from 'lodash';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { ZERO_ADDRESS } from './constants';
import { deploy } from './deploy';
import { formatEther, parseEther } from 'ethers/lib/utils';

export type TokenList = Dictionary<Contract>;

// Deploys multiple tokens and returns a symbol -> token dictionary, which can be used in other helpers
export async function deployTokens(
  symbols: Array<string>,
  decimals: Array<number>,
  from?: SignerWithAddress
): Promise<TokenList> {
  const tokenSymbols: TokenList = {};
  for (let i = 0; i < symbols.length; i++) {
    if (symbols[i] === 'WETH') {
      tokenSymbols[symbols[i]] = await deploy('WETH9', { from, args: [from ? from.address : ZERO_ADDRESS] });
    } else {
      tokenSymbols[symbols[i]] = await deployToken(symbols[i], decimals[i], from);
    }
  }
  return tokenSymbols;
}

export async function deploySortedTokens(
  symbols: Array<string>,
  decimals: Array<number>,
  from?: SignerWithAddress
): Promise<TokenList> {
  const [defaultDeployer] = await ethers.getSigners();
  const deployer = from || defaultDeployer;
  /*return fromPairs(
    (await Promise.all(symbols.map((_, i) => deployToken(`T${i}`, decimals[i], deployer))))
      .sort((tokenA, tokenB) => (tokenA.address.toLowerCase() > tokenB.address.toLowerCase() ? 1 : -1))
      .map((token, index) => [symbols[index], token])
  );*/
  const tokens = [];
  for (let index = 0; index < symbols.length; index++) {
    const symbol = symbols[index];
    const decimal = decimals[index];
    console.log(symbol);
    const token = await deployToken(`T${index}`, decimal, deployer);
    tokens.push(token);
    console.log('token', index);
  }

  return fromPairs(
    tokens
      .sort((tokenA, tokenB) => (tokenA.address.toLowerCase() > tokenB.address.toLowerCase() ? 1 : -1))
      .map((token, index) => [symbols[index], token])
  );
}

export async function deployToken(symbol: string, decimals?: number, from?: SignerWithAddress): Promise<Contract> {
  const [defaultDeployer] = await ethers.getSigners();
  const deployer = from || defaultDeployer;
  return deploy('TestToken', { from: deployer, args: [deployer.address, symbol, symbol, decimals] });
}

export async function mintTokens(
  tokens: TokenList,
  symbol: string,
  recipient: SignerWithAddress | string,
  amount: number | BigNumber | string
): Promise<void> {
  //await tokens[symbol].mint(typeof recipient == 'string' ? recipient : recipient.address, amount.toString());
  console.log(
    `Minting ${formatEther(amount.toString()).toString()} ${symbol} for ${
      typeof recipient == 'string' ? recipient : recipient.address
    }`
  );
  console.log(`${symbol} total supply: ${formatEther(await tokens[symbol].totalSupply())}`);
  const tx = await tokens[symbol].mint(
    typeof recipient == 'string' ? recipient : recipient.address,
    amount.toString(),
    {
      gasLimit: 1600000,
    }
  );
  console.log('waiting for receipt');
  await tx.wait();
  // console.log('minted!')
  console.log(`${symbol} total supply increased to: ${formatEther(await tokens[symbol].totalSupply())}`);
}
