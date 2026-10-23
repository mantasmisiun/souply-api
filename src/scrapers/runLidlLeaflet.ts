import 'dotenv/config';
import { runLidlLeafletScraper } from './lidl/leaflet.js';

runLidlLeafletScraper()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
