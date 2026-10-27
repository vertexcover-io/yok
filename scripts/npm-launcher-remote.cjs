#!/usr/bin/env node
// npm's bin for yok-remote: the yok launcher, with "remote" in front of the arguments.
process.argv.splice(2, 0, "remote");
require("./yok.js");
