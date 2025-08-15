import { ethers } from "ethers";

const provider = new ethers.JsonRpcProvider("https://rpc.sepolia.org");
const contractAddress = "0x216f071653a82ced3ef9d29f3f0c0ed7829c8f81";
const abi = [
  "event Staked(address indexed user, uint256 amount)",
  "event Withdrawn(address indexed user, uint256 amount)",
  "event ProverSlashed(address indexed prover, uint256 amount)"
];
const contract = new ethers.Contract(contractAddress, abi, provider);

async function getActiveProvers() {
  const balances = new Map();

  // 1. Staked events
  const stakedLogs = await contract.queryFilter("Staked", 0, "latest");
  stakedLogs.forEach(log => {
    const addr = log.args.user.toLowerCase();
    const amount = Number(log.args.amount);
    balances.set(addr, (balances.get(addr) || 0) + amount);
  });

  // 2. Withdrawn events
  const withdrawnLogs = await contract.queryFilter("Withdrawn", 0, "latest");
  withdrawnLogs.forEach(log => {
    const addr = log.args.user.toLowerCase();
    const amount = Number(log.args.amount);
    balances.set(addr, (balances.get(addr) || 0) - amount);
  });

  // 3. ProverSlashed events
  const slashedLogs = await contract.queryFilter("ProverSlashed", 0, "latest");
  slashedLogs.forEach(log => {
    const addr = log.args.prover.toLowerCase();
    const amount = Number(log.args.amount);
    balances.set(addr, (balances.get(addr) || 0) - amount);
  });

  // Count only provers with positive balance
  const activeCount = Array.from(balances.values()).filter(bal => bal > 0).length;

  return activeCount;
}

getActiveProvers().then(count => {
  console.log("Active Provers:", count);
});
