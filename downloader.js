const {ArgumentParser} = require("argparse");
const {URL} = require("url");
const path = require("path");
const fs = require("fs");
const afs = fs.promises;
const prompt = require("prompt-sync")();
const os = require("os");
const AdmZip = require("adm-zip");
const open = require("open");
const http = require("http");
const https = require("https");
const request = require("request");
const {version} = require("./package.json");

function copyFileSync(source, target) {
    var targetFile = target;

    if (fs.existsSync(target)) {
        if (fs.lstatSync(target).isDirectory()) {
            targetFile = path.join(target, path.basename(source));
        }
    }

    fs.writeFileSync(targetFile, fs.readFileSync(source));
}

function copyFolderRecursiveSync(source, target) {
    var files = [];

    var targetFolder = path.join(target, path.basename(source));

    if (!fs.existsSync(targetFolder)) {
        fs.mkdirSync(targetFolder);
    }

    if (fs.lstatSync(source).isDirectory()) {
        files = fs.readdirSync(source);

        files.forEach((file) => {
            var curSource = path.join(source, file);

            if (fs.lstatSync(curSource).isDirectory()) {
                copyFolderRecursiveSync(curSource, targetFolder);
            } else {
                copyFileSync(curSource, targetFolder);
            }
        });
    }
}

class CFD {
    static get mcDirs() {
        return {
            windows: path.join(process.env.APPDATA || "", ".minecraft"),
            mac: "~/Library/Application Support/minecraft",
            linux: path.join(process.env.HOME || "", ".minecraft")
        };
    }

    run() {
        this.configureArgparse().then(() => {
            return this.checkIfExists();
        }).then((doesExist) => {
            if (!doesExist) {
                return;
            }

            console.log("Getting modpack files...");
            return this.getModpackFiles();
        }).then(() => {
            console.log("Done getting modpack files.");
            console.log("Checking to see if the correct version of Forge is installed...");
            return this.checkForgeVersion();
        }).then(() => {
            console.log("Done checking for Forge installation.");
            console.log("Downloading mods...");
            return this.downloadMods();
        }).then((modsDownloaded) => {
            modsDownloaded.forEach((mod) => {
                console.log(`Downloaded ${mod.displayName}.`);
            });

            console.log("Done downloading mods.");
            console.log("Copying overrides...");
            return this.copyOverrides();
        }).then(() => {
            console.log("Done copying overrides.");
            console.log("Adding profile to stock launcher...");
            return this.addProfileToLauncher();
        }).then(() => {
            console.log("Done adding profile to stock launcher.");
        }).catch((reason) => {
            console.log(reason);
        });
    }

    configureArgparse() {
        return new Promise((resolve, reject) => {
            var parser = new ArgumentParser({description: "Install Minecraft CurseForge modpack into stock launcher"});
            parser.add_argument("-m", "--modpack", {type: String, help: "The zip or url to install"});
            parser.add_argument("-v", "--version", {action: "version", version: version});
            parser.add_argument("-l", "--location", {type: String, help: "The folder to install the modpack to"});
            //parser.add_argument("--mc-version", {type: String, default: "latest", help: "The Minecraft version to download this pack for. Defaults to latest.", dest: "mcVersion"});
            var args = parser.parse_args();

            if (args.modpack === undefined) {
                reject("Please input a modpack.");
            }

            if (path.extname(args.modpack) === ".zip") {
                if (!fs.existsSync(args.modpack)) {
                    reject("Zip file should exist.");
                }

                if (args.location === undefined) {
                    reject("Location needs to be entered")
                }

                this.packType = "file";
            } else {
                args.modpack = parseInt(args.modpack, 10) || undefined;
                
                if (args.modpack === undefined) {
                    reject("Please input either the path of a zip file or the modpack's id.");
                }

                this.packType = "id";
            }

            this.modpack = args.modpack;
            this.destination = args.location;
            this.mcVersion = args.mcVersion;
            resolve();
        });
    }

    checkIfExists() {
        return new Promise((resolve, reject) => {
            if (fs.existsSync(path.join(this.destination, "manifest.json"))) {
                var answer = prompt("A modpack already exists at this location, do you want to overrite it?\nY / N: ");
                return resolve(answer.toLowerCase() === "y");
            }

            resolve(true);
        });
    }

    getModpackFiles() {
        return new Promise((resolve, reject) => {
            if (this.packType === "id") {
                console.log("Downloading mod zip...");

                var options = {
                    hostname: "curse.nikky.moe",
                    path: `/api/addon/${this.modpack}`,
                    method: "GET",
                    json: true
                };

                return new Promise((nresolve, nreject) => {
                    var req = https.get(options, (res) => {
                        if ((res.statusCode < 200) || (res.statusCode >= 300)) {
                            return nreject(new Error(`statusCode=${res.statusCode}`));
                        }

                        var body = [];
                        res.on("data", (chunk) => {
                            body.push(chunk);
                        });

                        res.on("end", () => {
                            try {
                                body = JSON.parse(Buffer.concat(body).toString());
                            } catch(e) {
                                nreject(e);
                            }

                            nresolve(body);
                        });
                    });

                    req.on("error", (err) => {
                        nreject(err);
                    });

                    req.end();
                }).then((modpackData) => {
                    return new Promise((nresolve, nreject) => {
                        var fileID = modpackData.gameVersionLatestFiles[0].projectFileId;

                        /*if (this.mcVersion === "latest") {
                            fileID = modpackData.gameVersionLatestFiles[0].projectFileId;
                        } else {
                            var latestVersion = "0.0.0"
                            modpackData.gameVersionLatestFiles.forEach((fileData) => {

                            });
                        }*/
                        
                        options.path = `/api/addon/${this.modpack}/file/${fileID}`;

                        var req = https.get(options, (res) => {
                            if ((res.statusCode < 200) || (res.statusCode >= 300)) {
                                return nreject(new Error(`statusCode=${res.statusCode}`));
                            }

                            var body = [];
                            res.on("data", (chunk) => {
                                body.push(chunk);
                            });

                            res.on("end", () => {
                                try {
                                    body = JSON.parse(Buffer.concat(body).toString());
                                } catch(e) {
                                    nreject(e);
                                }

                                nresolve(body);
                            });
                        });

                        req.on("error", (err) => {
                            nreject(err);
                        });

                        req.end();
                    });
                }).then((zipData) => {
                    return new Promise((nresolve, nreject) => {
                        this.modpackFiles = fs.mkdtempSync(path.join(os.tmpdir(), "cfd-"));
                        var url = new URL(zipData.downloadUrl).toString();
                        var splitUrl = url.split("/");
                        var outFile = fs.createWriteStream(path.join(this.modpackFiles, splitUrl[splitUrl.length - 1]), {encoding: null});

                        request.get({url: url, encoding: null}, (err, res, body) => {
                            if (err) {
                                nreject(err);
                            }

                            res.on("end", () => {
                                nresolve(body);
                            }).on("error", (reason) => {
                                nreject(reason);
                            });
                        }).on("error", (err) => {
                            nreject(err);
                        }).on("complete", (res, body) => {
                            nresolve(body);
                        }).end();
                    });
                }).then((buf) => {
                    var zip = new AdmZip(buf);
                    zip.extractAllTo(this.modpackFiles, true);
                    console.log("Finished extracting modpack files.");
                    resolve();
                }).catch((reason) => {
                    reject(reason);
                });
            } else if (this.packType === "file") {
                console.log("Extracting modpack files...");
                this.modpackFiles = fs.mkdtempSync(path.join(os.tmpdir(), "cfd-"));
                var zip = new AdmZip(this.modpack);
                zip.extractAllTo(this.modpackFiles, true);
                console.log("Finished extracting modpack files.");
                resolve();
            } else {
                reject("The pack type should be either \"id\" or \"file\"");
            }
        });
    }

    checkForgeVersion() {
        var versionsDir = path.join(process.platform === "win32" ? CFD.mcDirs.windows : (process.platform === "darwin" ? CFD.mcDirs.mac : (process.platform === "linux" ? CFD.mcDirs.linux : "throw-an-error-deliberately")), "versions");
        var _files;

        return afs.readdir(versionsDir).then((files) => {
            _files = files;
            return afs.readFile(path.join(this.modpackFiles, "manifest.json"));
        }).then((manifestData) => {
            var manifestJson = JSON.parse(manifestData);

            if (_files.indexOf(manifestJson.minecraft.version + "-" + manifestJson.minecraft.modLoaders[0].id) === -1) {
                var url = `https://files.minecraftforge.net/net/minecraftforge/forge/index_${manifestJson.minecraft.version}.html`;
                console.log(`Please install forge version ${manifestJson.minecraft.modLoaders[0].id}.\nOpening your web browser to the download page.\nPlease come back to this installer and press enter here when you're done.`);
                setTimeout(() => {
                    open(url);
                }, 5000);
                prompt("Press enter to continue...");
                _files = fs.readdirSync(path.join(process.platform === "win32" ? CFD.mcDirs.windows : (process.platform === "darwin" ? CFD.mcDirs.mac : (process.platform === "linux" ? CFD.mcDirs.linux : "throw-an-error-deliberately")), "versions"));

                while (_files.indexOf(manifestJson.minecraft.version + "-" + manifestJson.minecraft.modLoaders[0].id) === -1) {
                    var url = `https://files.minecraftforge.net/net/minecraftforge/forge/index_${manifestJson.minecraft.version}.html`;
                    console.log(`Please install forge version ${manifestJson.minecraft.modLoaders[0].id}.\nOpening your web browser to the download page.\nPlease come back to this installer and press enter here when you're done.`);
                    setTimeout(() => {
                        open(url);
                    }, 5000);
                    prompt("Press enter to continue...");
                    files = fs.readdirSync(path.join(process.platform === "win32" ? CFD.mcDirs.windows : (process.platform === "darwin" ? CFD.mcDirs.mac : (process.platform === "linux" ? CFD.mcDirs.linux : "throw-an-error-deliberately")), "versions"));
                }
            }

            this.manifestData = manifestJson;
        });
    }

    downloadMods() {
        return afs.mkdir(path.join(this.destination, "mods"), {recursive: true}).then((val) => {
            var trashCounter = 0;
            var promises = [];

            this.manifestData.files.forEach((fileData) => {
                var options = {
                    hostname: "curse.nikky.moe",
                    path: `/api/addon/${fileData.projectID}/file/${fileData.fileID}`,
                    method: "GET",
                    json: true
                };

                promises.push(new Promise((resolve, reject) => {
                    var req = https.get(options, (res) => {
                        if ((res.statusCode < 200) || (res.statusCode >= 300)) {
                            return reject(new Error(`statusCode=${res.statusCode}`));
                        }

                        // cumulate data
                        var body = [];
                        res.on("data", (chunk) => {
                            body.push(chunk);
                        });

                        // resolve on end
                        res.on("end", () => {
                            try {
                                body = JSON.parse(Buffer.concat(body).toString());
                            } catch(e) {
                                reject(e);
                            }
                            resolve(body);
                        });
                    });

                    req.on("error", (err) => {
                        reject(err);
                    });
                    
                    req.end();
                }));
                
                setTimeout(() => {
                    trashCounter += 1;
                }, 1000);
            });

            return Promise.all(promises).then((mods) => {
                var modPromises = [];

                mods.forEach((mod) => {
                    modPromises.push(new Promise((resolve, reject) => {
                        var url = mod.downloadUrl;
                        var splitUrl = url.split("/");
                        var outFile = fs.createWriteStream(path.join(this.destination, "mods", splitUrl[splitUrl.length - 1]), {encoding: "binary", autoClose: true});
                        var req = https.get(url, (res) => {
                            res.pipe(outFile);

                            res.on("error", (err) => {
                                reject(err);
                            });

                            resolve(splitUrl[splitUrl.length - 1]);
                        });

                        req.on("error", (err) => {
                            reject(err);
                        });

                        req.end();

                        setTimeout(() => {
                            trashCounter += 1;
                        }, 1000);
                    }));
                });

                return Promise.all(promises);
            });
        });
    }

    copyOverrides() {
        var overridesFolder = path.join(this.modpackFiles, this.manifestData.overrides);
        return afs.readdir(overridesFolder).then((files) => {
            files.forEach((file) => {
                copyFolderRecursiveSync(path.join(overridesFolder, file), this.destination);
            });
        });
    }

    addProfileToLauncher() {
        var profilesFile = path.join(process.platform === "win32" ? CFD.mcDirs.windows : (process.platform === "darwin" ? CFD.mcDirs.mac : (process.platform === "linux" ? CFD.mcDirs.linux : "throw-an-error-deliberately")), "launcher_profiles.json");
        
        return afs.readFile(profilesFile).then((profilesData) => {
            var profilesJson = JSON.parse(profilesData);
            var date = new Date();

            profilesJson.profiles[this.manifestData.name.replace(" ", "_")] = {
                created: `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}T${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}.${date.getMilliseconds()}Z`,
                gameDir: path.resolve(this.destination),
                icon: "Redstone_Block",
                lastVersionId: `${this.manifestData.minecraft.version}-${this.manifestData.minecraft.modLoaders[0].id}`,
                name: this.manifestData.name,
                type: "custom"
            };

            return afs.writeFile(profilesFile, JSON.stringify(profilesJson, null, 2));
        });
    }
}

exports = {};
var cfd = new CFD();
cfd.run();