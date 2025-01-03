require('dotenv').config();
const { ApiPromise, WsProvider, Keyring } = require('@polkadot/api');
const { cryptoWaitReady } = require('@polkadot/util-crypto');
const BN = require('bn.js');

const WS_ENDPOINT = process.env.WS_ENDPOINT;
const SOURCE_SEED = process.env.SOURCE_SEED;
const TARGET_ADDRESS = process.env.TARGET_ADDRESS;

// 1 AZERO = 10^12 (on Aleph Zero)
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

  // We subscribe to new blocks to react as soon as possible
  console.log('Subscribing to new blocks...');
  await api.rpc.chain.subscribeNewHeads(async (header) => {
    console.log(`\nNew block #${header.number.toString()} detected. Checking balance...`);

    try {
      // Get available balance
      const balancesAll = await api.derive.balances.all(sourceAccount.address);
      const available = balancesAll.availableBalance; // BN
      const freeBal = balancesAll.freeBalance;
      const reservedBal = balancesAll.reservedBalance;
      const lockedBal = balancesAll.lockedBalance;

      
      console.log(`Free: ${freeBal.toString()}, Reserved: ${reservedBal.toString()}, Locked: ${lockedBal.toString()}, Available: ${available.toString()}`);

      console.log(`Available: ${available.toString()} plancks`);

      // If no transferable balance, do nothing
      if (available.lten(0)) {
        console.log('No transferable balance available.');
        return;
      }

      // Construct the dry-run transaction
      // (transferAll to your TARGET_ADDRESS, keepAlive=false)
      const tx = api.tx.balances.transferAll(TARGET_ADDRESS, false);

      // We'll do a dry run to estimate fees
      // 1) Create an unsigned extrinsic
      const unsigned = tx.toUnsigned();
      // 2) Convert to hex
      const txHex = unsigned.toHex();

      // 3) Query the estimated fee info
      const paymentInfo = await api.rpc.payment.queryInfo(txHex, sourceAccount.address);

      // paymentInfo.partialFee is the estimated fee in plancks
      const estimatedFee = paymentInfo.partialFee;

      console.log(`Estimated fee: ${estimatedFee.toString()} plancks`);

      // Next step: decide how much we can tip
      // We'll reserve "estimatedFee" from the available, plus some buffer
      // to avoid rounding or small discrepancies. Let’s pick 10% extra for safety:
      const bufferFactor = 1.1;
      const bufferFee = new BN(estimatedFee.muln(Math.ceil(bufferFactor * 100)).divn(100));

      // Now, totalBalance = available
      // If totalBalance <= bufferFee, we can’t pay a tip at all
      let tip = new BN(0);
      const spendableAfterFees = available.sub(bufferFee);

      if (spendableAfterFees.lte(new BN(0))) {
        // We can't even pay fees comfortably, so send with zero tip
        console.log('Not enough balance to tip safely. Will use zero tip.');
      } else {
        // We have something left to tip after fees
        if (spendableAfterFees.gt(ONE_AZERO)) {
          // If it's greater than 1 AZERO, cap tip at 1 AZERO
          tip = ONE_AZERO;
          console.log(`Tip capped at 1 AZERO (${ONE_AZERO.toString()}).`);
        } else {
          // Otherwise, use all leftover as tip
          tip = spendableAfterFees;
          console.log(`Using leftover as tip: ${tip.toString()} plancks.`);
        }
      }

      // Now sign and send with the decided tip
      await signAndSendTx(tx, sourceAccount, tip, api);

    } catch (err) {
      console.error('Error in subscribeNewHeads callback:', err);
    }
  });
}

// Helper function to sign and send the extrinsic with a tip
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
