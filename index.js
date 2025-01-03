require('dotenv').config();
const { ApiPromise, WsProvider, Keyring } = require('@polkadot/api');
const { cryptoWaitReady } = require('@polkadot/util-crypto');
const BN = require('bn.js');

const WS_ENDPOINT = process.env.WS_ENDPOINT;       // e.g., "wss://..."
const SOURCE_SEED = process.env.SOURCE_SEED;       // mnemonic or raw seed
const TARGET_ADDRESS = process.env.TARGET_ADDRESS; // recipient

// On Aleph Zero, 1 AZERO = 10^12 plancks
const ONE_AZERO = new BN('1000000000000');

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

  // Subscribe to new blocks so we can react immediately
  console.log('Subscribing to new blocks...');
  await api.rpc.chain.subscribeNewHeads(async (header) => {
    console.log(`\nNew block #${header.number.toString()} detected. Checking balance...`);

    try {
      // 1) Retrieve balances
      const balancesAll = await api.derive.balances.all(sourceAccount.address);
      const freeBal = balancesAll.freeBalance;
      const reservedBal = balancesAll.reservedBalance;
      const lockedBal = balancesAll.lockedBalance;
      const available = balancesAll.availableBalance;

      console.log(
        `Free: ${freeBal.toString()}, ` +
        `Reserved: ${reservedBal.toString()}, ` +
        `Locked: ${lockedBal.toString()}, ` +
        `Available: ${available.toString()}`
      );

      // If no transferable balance, skip
      if (available.lten(0)) {
        console.log('No transferable balance available.');
        return;
      }

      // 2) Construct the extrinsic (transferAll, keepAlive=false)
      const tx = api.tx.balances.transferAll(TARGET_ADDRESS, false);

      // 3) Estimate fees with the .paymentInfo(...) method
      const paymentInfo = await tx.paymentInfo(sourceAccount);
      const estimatedFee = paymentInfo.partialFee;
      console.log(`Estimated fee: ${estimatedFee.toString()} plancks`);

      // 4) Apply a small buffer to avoid underestimating fees
      const bufferFactor = 1.1; 
      const bufferFee = estimatedFee
        .muln(Math.ceil(bufferFactor * 100))
        .divn(100);

      // 5) Calculate how much is leftover for tip
      // leftover = available - bufferFee
      const leftover = available.sub(bufferFee);

      // If leftover <= 0, we can't safely tip
      if (leftover.lten(0)) {
        console.log('Not enough balance to tip safely. Sending with zero tip...');
        await signAndSendTx(tx, sourceAccount, new BN(0), api);
        return;
      }

      // If leftover > 0, decide how much to tip
      let tip;
      if (leftover.gt(ONE_AZERO)) {
        // Cap at 1 AZERO
        tip = ONE_AZERO;
        console.log(`Leftover > 1 AZERO. Capping tip at 1 AZERO (${ONE_AZERO.toString()}).`);
      } else {
        // Otherwise use leftover as tip
        tip = leftover;
        console.log(`Using leftover as tip: ${tip.toString()} plancks.`);
      }

      // 6) Sign & send with the decided tip
      await signAndSendTx(tx, sourceAccount, tip, api);

    } catch (err) {
      console.error('Error in subscribeNewHeads callback:', err);
    }
  });
}

// Helper function: sign and send with a tip
async function signAndSendTx(tx, sourceAccount, tip, api) {
  try {
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
  } catch (error) {
    console.error('Error during signAndSendTx:', error);
  }
}

main().catch(console.error);
