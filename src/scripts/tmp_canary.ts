import '../config/env.js';
import mysql from 'mysql2/promise';
import { getStoreProductsByChainWithProductData } from '../models/storeProductModel.js';
import { findBestProductMatches } from '../utils/productMatcher.js';
import { RECOGNITION } from '../../../shared/recognitionConfig.js';
const s = (v:any)=>(typeof v==='string'?v.replace(/^["']|["']$/g,''):v);
const c=await mysql.createConnection({host:s(process.env.DB_HOST),port:Number(s(process.env.DB_PORT)),user:s(process.env.DB_USER),password:s(process.env.DB_PASSWORD),database:s(process.env.DB_NAME)});
const [r203]:any=await c.query('SELECT id FROM Receipt WHERE id=203');
console.log('receipt 203 exists?', r203.length>0);
const [sp]:any=await c.query("SELECT id,storeProductName FROM StoreProduct WHERE id IN (60946,60808,60816)");
console.log('canary SPs still exist:'); for(const p of sp) console.log(`  ${p.id}: "${p.storeProductName}"`);
// live-catalog match for the canary ocrName
const cands=await getStoreProductsByChainWithProductData(3);
const m:any=findBestProductMatches('IKI SMULKINTA KIAUL IENA R', null, null, cands, undefined, RECOGNITION.match.topN, null);
console.log('\nlive match for "IKI SMULKINTA KIAUL IENA R":');
for(const x of m.slice(0,5)) console.log(`  ${x.confidence.toFixed(3)} SP ${x.storeProductId} "${x.name}"`);
// is there a rejected alias for this ocr on 60946?
const [ali]:any=await c.query("SELECT storeProductId,normalizedAlias,status FROM StoreProductReceiptAlias WHERE storeProductId IN (60946,60808,60816)");
console.log('\naliases on canary SPs:', ali.length); for(const a of ali) console.log(`  sp ${a.storeProductId} "${a.normalizedAlias}" ${a.status}`);
await c.end();
