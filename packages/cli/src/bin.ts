#!/usr/bin/env node
import { startDevaiCli } from './release-host.js';

process.exitCode = await startDevaiCli(process.argv);
