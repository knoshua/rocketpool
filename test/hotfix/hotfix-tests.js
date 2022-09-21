import {
    RocketDAOProtocolSettingsMinipool,
    RocketDAOProtocolSettingsNetwork,
    RocketStorage,
    RocketDAONodeTrustedSettingsMinipool, RocketNodeManager, RocketNodeManagerOld, RocketHotfixNodeFee,
} from '../_utils/artifacts';
import { printTitle } from '../_utils/formatting';
import { userDeposit } from '../_helpers/deposit';
import { getMinipoolMinimumRPLStake, createMinipool, stakeMinipool } from '../_helpers/minipool';
import { setNodeTrusted, nodeStakeRPL } from '../_helpers/node';
import { mintRPL } from '../_helpers/tokens';
import { setDAOProtocolBootstrapSetting } from '../dao/scenario-dao-protocol-bootstrap';
import { increaseTime, mineBlocks } from '../_utils/evm'
import {
    setDAONodeTrustedBootstrapSetting,
    setDaoNodeTrustedBootstrapUpgrade
} from '../dao/scenario-dao-node-trusted-bootstrap';
import { submitPrices } from '../_helpers/network';
import { upgradeOneDotOne } from '../_utils/upgrade';

export default function() {
    contract('RocketHotfixNodeFee', async (accounts) => {


        // Accounts
        const [
            owner,
            nodeOperator1,
            nodeOperator2,
            trustedNode,
            random,
            hotfixDeployer
        ] = accounts;


        // Setup
        let launchTimeout =  (60 * 60 * 72); // 72 hours
        let withdrawalDelay = 20;
        let scrubPeriod = (60 * 60 * 24); // 24 hours
        let hotfixContract


        // Register a node
        async function registerNode(txOptions) {
            const rocketNodeManager = await RocketNodeManagerOld.deployed();
            await rocketNodeManager.registerNode('Australia/Brisbane', txOptions);
        }


        before(async () => {
            // Register nodes
            await registerNode({from: nodeOperator1});
            await registerNode({from: nodeOperator2});

            // Register trusted node
            await registerNode({from: trustedNode});
            await setNodeTrusted(trustedNode, 'saas_1', 'node@home.com', owner);

            // Set settings
            await setDAOProtocolBootstrapSetting(RocketDAOProtocolSettingsMinipool, 'minipool.launch.timeout', launchTimeout, {from: owner});
            await setDAOProtocolBootstrapSetting(RocketDAOProtocolSettingsMinipool, 'minipool.withdrawal.delay', withdrawalDelay, {from: owner});
            await setDAONodeTrustedBootstrapSetting(RocketDAONodeTrustedSettingsMinipool, 'minipool.scrub.period', scrubPeriod, {from: owner});

            // Set rETH collateralisation target to a value high enough it won't cause excess ETH to be funneled back into deposit pool and mess with our calcs
            await setDAOProtocolBootstrapSetting(RocketDAOProtocolSettingsNetwork, 'network.reth.collateral.target', web3.utils.toWei('50', 'ether'), {from: owner});

            // Set RPL price
            let block = await web3.eth.getBlockNumber();
            await submitPrices(block, web3.utils.toWei('1', 'ether'), '0', {from: trustedNode});

            // Add the hotfix contract
            const rocketStorage = await RocketStorage.deployed();
            hotfixContract = await RocketHotfixNodeFee.new(rocketStorage.address, {from: hotfixDeployer});
            await setDaoNodeTrustedBootstrapUpgrade('addContract', 'rocketHotfixNodeFee', hotfixContract.abi, hotfixContract.address, {
                from: owner,
            });

            // Stake RPL to cover minipools
            let minipoolRplStake = await getMinipoolMinimumRPLStake();
            let rplStake = minipoolRplStake.mul(web3.utils.toBN(10));
            await mintRPL(owner, nodeOperator1, rplStake);
            await nodeStakeRPL(rplStake, {from: nodeOperator1}, true);
            await mintRPL(owner, nodeOperator2, rplStake);
            await nodeStakeRPL(rplStake, {from: nodeOperator2}, true);
        });


        async function setNodeFee(feePercent) {
            const fee = web3.utils.toWei(feePercent, 'ether');
            await setDAOProtocolBootstrapSetting(RocketDAOProtocolSettingsNetwork, 'network.node.fee.minimum', fee, {from: owner});
            await setDAOProtocolBootstrapSetting(RocketDAOProtocolSettingsNetwork, 'network.node.fee.target', fee, {from: owner});
            await setDAOProtocolBootstrapSetting(RocketDAOProtocolSettingsNetwork, 'network.node.fee.maximum', fee, {from: owner});
        }


        it.only(printTitle('hotfix', 'correctly adjusts the node fee'), async () => {
            // Get contract
            const nodeManager = await RocketNodeManager.deployed();
            // Set node fee to static 10%
            await setNodeFee('0.10')
            // Deploy a minipool with 10% node fee
            const minipool1 = await createMinipool({from: nodeOperator1, value: web3.utils.toWei('32', 'ether')}, null, true);
            await increaseTime(web3, scrubPeriod + 1);
            await stakeMinipool(minipool1, {from: nodeOperator1});
            // Set node fee to static 15%
            await setNodeFee('0.15')
            // Deploy a minipool with 15% node fee
            const minipool2 = await createMinipool({from: nodeOperator2, value: web3.utils.toWei('32', 'ether')}, null, true);
            await increaseTime(web3, scrubPeriod + 1);
            await stakeMinipool(minipool2, {from: nodeOperator2});
            /*
             * At this time we have nodeOperator1 with a single staking 10% minipool and nodeOperator2 with a single staking
             * 15% minipool.
             *
             * The bug occurs when we perform an upgrade and nodeOperator2 will have an incorrect 10% fee
             */
            await upgradeOneDotOne(owner);
            // Initialise fee distributors
            await nodeManager.initialiseFeeDistributor({from: nodeOperator1});
            await nodeManager.initialiseFeeDistributor({from: nodeOperator2});
            // Confirm the bug occurred (both have 10% node fee)
            const nodeOperator1Fee = await nodeManager.getAverageNodeFee(nodeOperator1);
            const nodeOperator2Fee = await nodeManager.getAverageNodeFee(nodeOperator2);
            assert(nodeOperator1Fee.toString() === web3.utils.toWei('0.10', 'ether'));
            assert(nodeOperator2Fee.toString() === web3.utils.toWei('0.10', 'ether'));
            // Set the error amounts
            await hotfixContract.addErrors([
                {
                    nodeAddress: nodeOperator2,
                    amount: web3.utils.toWei('0.05', 'ether')
                }
            ], {from: hotfixDeployer});
            // Execute the hotfix
            await hotfixContract.execute({from: owner});
            // Confirm the fix
            const nodeOperator1FeeAfter = await nodeManager.getAverageNodeFee(nodeOperator1);
            const nodeOperator2FeeAfter = await nodeManager.getAverageNodeFee(nodeOperator2);
            assert(nodeOperator1FeeAfter.toString() === web3.utils.toWei('0.10', 'ether'));
            assert(nodeOperator2FeeAfter.toString() === web3.utils.toWei('0.15', 'ether'));
        });

        it.only(printTitle('hotfix', 'can adjust 600 values in a single tx'), async () => {
            // Deploy helper contract
            const rocketStorage = await RocketStorage.deployed();
            const fakeNumeratorContract = await artifacts.require('FakeNumerator').new(rocketStorage.address, {from: owner});
            await setDaoNodeTrustedBootstrapUpgrade('addContract', 'fakeNumerator', fakeNumeratorContract.abi, fakeNumeratorContract.address, {
                from: owner,
            });
            // Create 600 random node addresses
            function randomAddress() {
                let result = '0x';
                let characters = '0123456789abcdef';
                let charactersLength = characters.length;
                for ( let i = 0; i < 40; i++ ) {
                    result += characters.charAt(Math.floor(Math.random() * charactersLength));
                }
                return result;
            }
            const nodeAddresses = []
            for (let i = 0; i < 600; i++) {
                nodeAddresses.push(randomAddress());
            }
            // Register all nodes
            await Promise.all(nodeAddresses.map(nodeAddress => fakeNumeratorContract.setNumerator(nodeAddress, web3.utils.toWei('0.1', 'ether'))));
            // Construct array of errors
            let totalGas = web3.utils.toBN('0');
            let errors = [];
            for (let i = 0; i < nodeAddresses.length; i++) {
                errors.push({
                    nodeAddress: nodeAddresses[i],
                    amount: web3.utils.toWei('0.05', 'ether')
                })
                if (i % 100 === 0){
                    const tx = await hotfixContract.addErrors(errors, {from: hotfixDeployer});
                    totalGas = totalGas.add(web3.utils.toBN(tx.receipt.gasUsed));
                    errors = [];
                }
            }
            let tx = await hotfixContract.addErrors(errors, {from: hotfixDeployer});
            totalGas = totalGas.add(web3.utils.toBN(tx.receipt.gasUsed));
            // Execute the hotfix
            tx = await hotfixContract.execute({from: owner});
            console.log('Execution gas used: ' + tx.receipt.gasUsed.toString());
            totalGas = totalGas.add(web3.utils.toBN(tx.receipt.gasUsed));
            console.log('Total gas used: ' + totalGas.toString());
      });
    })
}
