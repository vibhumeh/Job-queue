# setup.sh
#!/bin/bash

echo "Setting up testing keypairs..."

mkdir -p keys

# Generate keypairs
solana-keygen new --outfile keys/owner.json --no-bip39-passphrase --silent
solana-keygen new --outfile keys/worker.json --no-bip39-passphrase --silent

OWNER_PUBKEY=$(solana-keygen pubkey keys/owner.json)
WORKER_PUBKEY=$(solana-keygen pubkey keys/worker.json)

echo "👤 Owner:  $OWNER_PUBKEY"
echo "🔧 Worker: $WORKER_PUBKEY"

echo "\n Airdropping SOL..."
solana airdrop 2 $OWNER_PUBKEY --url devnet
sleep 2
solana airdrop 2 $WORKER_PUBKEY --url devnet
sleep 2
echo "for simulation of both owner and worker:"
echo "   Terminal 1: ts-node scripts/owner.ts keys/owner.json $WORKER_PUBKEY"
echo "   Terminal 2: ts-node scripts/worker.ts keys/worker.json $OWNER_PUBKEY"

echo "for cli owner:"
echo "   Terminal 1: ts-node scripts/cli.ts keys/owner.json"
echo "Worker we are keeping as simulated worker for testing cli."
echo " Remember to approve the worker using cli before adding jobs!"