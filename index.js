require('dotenv').config();
const { ApiPromise, WsProvider, Keyring } = require('@polkadot/api');
const { cryptoWaitReady } = require('@polkadot/util-crypto');

const WS_ENDPOINT = process.env.WS_ENDPOINT;
const SOURCE_SEED = process.env.SOURCE_SEED;
const TARGET_ADDRESS = process.env.TARGET_ADDRESS;

async function main() {
    await cryptoWaitReady();
    console.log("Crypto ready");

    console.log("Connecting to Aleph Zero endpoint:", WS_ENDPOINT);
    const provider = new WsProvider(WS_ENDPOINT);

    const api = await ApiPromise.create({ provider });
    console.log("API initialized.");

    const keyring = new Keyring({ type: 'sr25519' });
    const sourceAccount = keyring.addFromUri(SOURCE_SEED);
    console.log("Source account loaded:", sourceAccount.address);

    console.log(`Monitoring balance of ${sourceAccount.address}...`);

    console.log("Available pallets:", Object.keys(api.tx));
    if (!api.tx.balances) {
        throw new Error("No balances pallet found in this runtime.");
    }
    console.log("Available balances methods:", Object.keys(api.tx.balances));

    // Use transferAll with keepAlive = false to empty the account completely.
    const transferMethod = 'transferAll';

    async function sweepIfNeeded() {
        try {
            console.log("Checking balance...");

            // Derived balances give us an overview, but for transferAll we just need to know if there's anything to send.
            const balancesAll = await api.derive.balances.all(sourceAccount.address);
            const freeBal = balancesAll.freeBalance;
            const reservedBal = balancesAll.reservedBalance;
            const lockedBal = balancesAll.lockedBalance;
            const available = balancesAll.availableBalance; // Transferable funds (not considering fees)
            
            console.log(`Free: ${freeBal.toString()}, Reserved: ${reservedBal.toString()}, Locked: ${lockedBal.toString()}, Available: ${available.toString()}`);

            if (available.lten(0)) {
                console.log("No transferable balance available to sweep.");
                return;
            }

            // Attempt to transfer all free funds
            const tx = api.tx.balances[transferMethod](TARGET_ADDRESS, false);
            console.log(`Sweeping all free funds (${available.toString()}) to ${TARGET_ADDRESS}, account may be emptied...`);

            const unsub = await tx.signAndSend(sourceAccount, ({ status, dispatchError }) => {
                if (status.isInBlock || status.isFinalized) {
                    console.log(`Transaction included at blockHash ${status.asInBlock || status.asFinalized}`);
                    if (dispatchError) {
                        if (dispatchError.isModule) {
                            const metaError = api.registry.findMetaError(dispatchError.asModule);
                            const { name, section } = metaError;
                            console.log(`Transaction failed with error: ${section}.${name}`);
                        } else {
                            console.log('Transaction failed with error:', dispatchError.toString());
                        }
                    } else {
                        console.log('Transfer successful. Account may now be empty.');
                    }
                    unsub();
                }
            });
        } catch (error) {
            console.error('Error during sweep:', error);
        }
    }

    // Run sweep every second
    setInterval(sweepIfNeeded, 1000);
}

main().catch(console.error);
