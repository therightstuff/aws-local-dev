const fs = require("fs");
const fse = require("fs-extra");
const childProcess = require("child_process");

console.log(`updating cdk project packages`);
childProcess.execSync('npx npm-check-updates -u');

// get layers' src directories
let srcdirs = fs.readdirSync('layers/src', { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);

for (let i in srcdirs) {
    let layer = srcdirs[i];
    console.log(`\nupdating packages for layer ${layer}...`);

    let layerSrcPath = `layers/src/${layer}`
    childProcess.execSync('npx npm-check-updates -u', { cwd: layerSrcPath });
}