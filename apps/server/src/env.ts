// Loads .env for the standalone CLI: $ENV_FILE, else the nearest .env up from cwd.

import dotenv from 'dotenv';
import { findUp } from './config.js';

const file = process.env.ENV_FILE || findUp('.env');
if (file) dotenv.config({ path: file, quiet: true });
