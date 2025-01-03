require('dotenv').config();
const { ApiPromise, WsProvider, Keyring } = require('@polkadot/api');
const { cryptoWaitReady } = require('@polkadot/util-crypto');
const BN = require('bn.js');

const WS_ENDPOINT = process.env.WS_ENDPOINT;       // e.g., "wss://yournode.io"
const SOURCE_SEED = process.env.SOURCE_SEED;       // e.g., a mnemonic or raw seed
const TARGET_ADDRESS = process.env.TARGET_ADDRESS; // address receiving the swept funds

// On Aleph Zero, 1 AZERO = 10^12 plancks
const ONE_AZERO = new BN('1000000000000');

// We'll use a fixed buffer to cover fees (e.g., 0.00005 AZERO).
// Adjust if you find it failing with “InsufficientBalance.”
const FEE_BUFFER = new BN('50000000'); // 0.00005 AZERO

async function main() {
  await cryptoWaitReady();
  console.log('Crypto ready');

  console.log('Connecting to Aleph Zero endpoint:', WS_ENDPOINT);
  const provider = new WsProvider(WS_ENDPOINT);
  const api = await ApiPromise.create({ provider });
  console.log('API initialized');

  const keyring = new Keyring({ type: 'sr25519' });
  const sourceAccount = keyring.addFromUri(SOURCE_SEED);
  console.log('Source account loaded:', sourceAccount.address);

  // Subscribe to new blocks
  console.log('Subscribing to new blocks...');
  await api.rpc.chain.subscribeNewHeads(async (header) => {
    console.log(`\nNew block #${header.number.toString()} detected. Checking balance...`);

    try {
      // 1) Retrieve current balances
      const balancesAll = await api.derive.balances.all(sourceAccount.address);
      const freeBal = balancesAll.freeBalance;
      const reservedBal = balancesAll.reservedBalance;
      const lockedBal = balancesAll.lockedBalance;
      const available = balancesAll.availableBalance; // BN

      console.log(
        `Free: ${freeBal.toString()}, ` +
        `Reserved: ${reservedBal.toString()}, ` +
        `Locked: ${lockedBal.toString()}, ` +
        `Available: ${available.toString()}`
      );

      if (available.lten(0)) {
        console.log('No transferable balance available.');
        return;
      }

      // 2) Construct the extrinsic (transferAll, keepAlive=false)
      const tx = api.tx.balances.transferAll(TARGET_ADDRESS, false);

      // 3) Decide tip based on leftover after the fixed buffer
      let leftover = available.sub(FEE_BUFFER);
      if (leftover.lten(0)) {
        // If not enough balance to safely cover our buffer, tip zero
        leftover = new BN(0);
      }

      // Cap tip at 1 AZERO (OneAzero)
      const tip = BN.min(leftover, ONE_AZERO);

      console.log(
        `Will send with tip: ${tip.toString()} plancks (buffer = ${FEE_BUFFER.toString()}).`
      );

      // 4) Sign & send with our chosen tip
      const unsub = await tx.signAndSend(
        sourceAccount,
        { tip },
        ({ status, dispatchError }) => {
          if (status.isInBlock || status.isFinalized) {
            const blockHash = status.asInBlock || status.asFinalized;
            console.log(`Transaction included at blockHash ${blockHash}`);

            if (dispatchError) {
              if (dispatchError.isModule) {
                const metaError = api.registry.findMetaError(dispatchError.asModule);
                const { name, section } = metaError;
                console.log(`Transaction failed with error: ${section}.${name}`);
              } else {
                console.log(`Transaction failed with error: ${dispatchError.toString()}`);
              }
            } else {
              console.log('Transfer successful. Account may now be empty.');
            }
            unsub();
          }
        }
      );

    } catch (err) {
      console.error('Error in subscribeNewHeads callback:', err);
    }
  });
}

main().catch(console.error);
