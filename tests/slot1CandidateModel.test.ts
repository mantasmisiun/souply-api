import { bestCrossChainSimilarity } from '../src/models/slot1CandidateModel.js';
import { crossChainNameSimilarity } from '../src/utils/productNameNormalize.js';

// Vocab-driven queue (H3 part 2): cross-chain identity scoring considers each product's
// canonical receipt-name aliases, so a learned print bridges pairs the catalog names miss.
describe('bestCrossChainSimilarity (vocab bridge)', () => {
    it('with no aliases on either side, equals the plain name×name similarity', () => {
        expect(bestCrossChainSimilarity('Pienas Dvaras', [], 'Pienas Dvaras', []))
            .toBe(crossChainNameSimilarity('Pienas Dvaras', 'Pienas Dvaras'));
    });

    it("an anchor's canonical alias bridges a pair the names miss", () => {
        const anchorName = 'completely unrelated anchor text';
        const candName = 'shared bridge phrase abcd';
        const namesOnly = bestCrossChainSimilarity(anchorName, [], candName, []);
        const withAlias = bestCrossChainSimilarity(anchorName, [candName.toLowerCase()], candName, []);
        expect(withAlias).toBeGreaterThan(namesOnly);
        // The best pair is the alias↔candidate-name match, not the unrelated names.
        expect(withAlias).toBe(crossChainNameSimilarity(candName.toLowerCase(), candName));
    });

    it('a canonical alias on the CANDIDATE side bridges too', () => {
        const anchorName = 'shared bridge phrase abcd';
        const candName = 'totally different candidate name';
        const withAlias = bestCrossChainSimilarity(anchorName, [], candName, [anchorName.toLowerCase()]);
        expect(withAlias).toBe(crossChainNameSimilarity(anchorName, anchorName.toLowerCase()));
    });
});
