const fs = require('fs');
const sqlite = require('node:sqlite');

const sdeDatabase = new sqlite.DatabaseSync('sqlite-latest.sqlite', {readOnly: true, returnArrays: true});
const fitDatabase = new sqlite.DatabaseSync('savedata.db', {readonly: true, returnArrays: true});

const dupeHash = JSON.parse(fs.readFileSync('dupes.json', 'utf-8'));
const myDiffs = JSON.parse(fs.readFileSync('my-diffs.json', 'utf-8'));

fs.readdir('.', (err, files) => {
    var charFiles = files.filter((v,i,a) => {
        return /^char-\d+\.txt$/.test(v);
    });
    charFiles.forEach((v,i,a) => {
        var charId = /-(.*)\.txt$/[Symbol.match](v)[1];
        var myFiles = [
            ['assets', 'assets-' + charId + '.json'],
            ['namedItems', 'named_items-' + charId + '.json'],
            ['stations', 'stations-' + charId + '.json'],
            ['structures', 'structures-' + charId + '.json']
        ];
        if (!myFiles.every(v => {return files.indexOf(v[1]) !== -1})) {
            throw Error('cannot find all files');
        }
        var assetData = {
            name: fs.readFileSync(v, 'utf-8'),
        };
        myFiles.forEach((v,i,a) => {
            var fileContents = fs.readFileSync(v[1], 'utf-8');
            assetData[v[0]] = JSON.parse(fileContents);
        });
        processAssetData(assetData);
    });
});

function processAssetData(assetData) {
    var hangarAssets = assetData.assets.filter((v,i,a) => {
        return v.location_flag === 'Hangar' && v.is_singleton && !v.is_blueprint_copy;
    });
    var mappedHangarAssets = hangarAssets.map((v,i,a) => {
        var name = assetData.namedItems.find(elem => {
            return elem.item_id === v.item_id;
        });
        var ret = JSON.stringify(v);
        ret = JSON.parse(ret);
        ret.name = name ? name.name : 'No Name';
        return ret;
    });
    mappedHangarAssets.forEach((v,i,a) => {
        if (!isShip(v.type_id)) {
            return;
        }
        var fit = buildFit(v, assetData);
        if (fit.name.startsWith('+')) {
            matchFit(fit);
            if (fit.escape) {
                console.error('escape!');
                matchFit(fit.escape);
            } else if (shouldHaveEscapeFrig(fit.typeId)) {
                console.error('NO ESCAPE');
            }
        }
    });
}

function isShip(typeId) {
    // TODO: actually look up the types.
    // right now this just excludes the specific containers I use and capsules.
    return typeId !== 33003 && typeId !== 670;
}

function shouldHaveEscapeFrig(typeId) {
    const query = sdeDatabase.prepare('select attributeID from dgmTypeAttributes where attributeID=3020 and typeID=' + typeId);
    var ret = query.all();
    return !!ret.length;
}

function getTypeName(typeId) {
    if (!typeId) {
        return 'null';
    }
    const query = sdeDatabase.prepare('select it.typeName from invTypes it where it.typeID=' + typeId);
    var ret = query.all()[0].typeName;
    return ret;
}

function getTypeId(typeName) {
    const query = sdeDatabase.prepare('select it.typeID from invTypes it where it.typeName=?');
    var ret = query.all(typeName);
    if (!ret) {
        throw Error('cannot find ' + typeName + '\'s typeID');
    }
    return ret[0].typeID;
}

function buildFit(v, assetData) {
    var ship = {
        itemId: v.item_id,
        locationId: v.location_id,
        typeId: v.type_id,
        name: v.name
    };

    var station = assetData.stations.find((elem) => {
        return elem.station_id === ship.locationId;
    });
    if (!station) {
        station = assetData.structures.find((elem) => {
            return elem.id === ship.locationId;
        });
    }
    ship.locationName = station.name;

    ship.typeName = getTypeName(ship.typeId);

    var directItems = assetData.assets.filter((elem) => {
        return elem.location_id === ship.itemId;
    });

    function fillInventory(container, items) {
        for (var i = 0; i < items.length; i++) {
            var item = {
                typeId: items[i].type_id,
                typeName: getTypeName(items[i].type_id),
                // itemId: items[i].item_id,
                quantity: items[i].quantity,
            };
            var locFlag = items[i].location_flag;
            var itemType = null;
            if (/(Hi|Med|Lo|Rig|SubSystem)Slot\d+/.test(locFlag)) {
                itemType = 'modules';
            } else if (/(SubSystemBay|Cargo|FleetHangar|SpecializedFuelBay)/.test(locFlag)) {
                itemType = 'cargo';
            } else if (locFlag === 'DroneBay') {
                itemType = 'drones';
            } else if (/Fighter(Bay|Tube)/.test(locFlag)) {
                itemType = 'fighters';
            } else if (locFlag === 'FrigateEscapeBay') {
                var escapeBayName = assetData.namedItems.find(elem => {
                    return elem.item_id === items[i].item_id;
                });
                var escapeBayFit = {
                    itemId: items[i].item_id,
                    locationId: items[i].location_id,
                    typeId: items[i].type_id,
                    name: escapeBayName.name
                };
                var escapeBayDirects = assetData.assets.filter((elem) => {
                    return elem.location_id === items[i].item_id;
                });
                fillInventory(escapeBayFit, escapeBayDirects);
                container.escape = escapeBayFit;
            } else {
                console.error(locFlag);
                console.error(items[i]);
                console.error(getTypeName(items[i].type_id));
                console.error('----------------------------------------');
            }

            if (!itemType) {
                continue;
            }

            container[itemType] = container[itemType] || [];
            var existing = container[itemType].find(v => {
                return v.typeId === item.typeId;
            });
            if (existing) {
                existing.quantity += item.quantity;
            } else {
                container[itemType].push(item);
            }
        }
    }

    if (directItems.length) {
        fillInventory(ship, directItems);
    }

    return ship;
}

function matchFit(ship) {
    const query = fitDatabase.prepare('select f.ID,f.name,f.notes from fits f where f.shipID=' + ship.typeId);
    var poss = query.all().map((v,i,a) => {
        var ret = {
            fitId: v.ID,
            typeId: ship.typeId,
            typeName: ship.typeName,
            fitName: v.name,
            fitNotes: v.notes,
            modules: [],
            drones: [],
            cargo: [],
            fighters: [],
        };
        
        const modules = fitDatabase.prepare('select m.itemID, count(m.itemID) as c from modules m where m.fitID=' + v.ID + ' group by m.itemID').all();
        modules.forEach((fi) => {
            ret.modules.push({
                typeId: fi.itemID,
                typeName: getTypeName(fi.itemID),
                quantity: fi.c
            });
        });
        const drones = fitDatabase.prepare('select itemID, sum(amount) as c from drones where fitID=' + v.ID + ' group by itemID').all();
        drones.forEach((fi) => {
            ret.drones.push({
                typeId: fi.itemID,
                typeName: getTypeName(fi.itemID),
                quantity: fi.c
            });
        });
        const cargo = fitDatabase.prepare('select itemID, sum(amount) as c from cargo where fitID=' + v.ID + ' group by itemID').all();
        cargo.forEach((fi) => {
            ret.cargo.push({
                typeId: fi.itemID,
                typeName: getTypeName(fi.itemID),
                quantity: fi.c
            });
        });
        const fighters = fitDatabase.prepare('select itemID, sum(amount) as c from fighters where fitID=' + v.ID + ' group by itemID').all();
        fighters.forEach((fi) => {
            var mul = 1;
            if (fi.c < 0) {
                // pyfa stores fighters as groups. -1 fighters means 1 full squad of that fighter type
                // a full squad is 9000m3.
                var mul = -9000 / sdeDatabase.prepare('select volume from invTypes where typeID=' + fi.itemID).all()[0].volume;
            }
            ret.fighters.push({
                typeId: fi.itemID,
                typeName: getTypeName(fi.itemID),
                quantity: fi.c * mul
            });
        });

        // apply person diffs
        myDiffs.forEach(myDiff => {
            if (myDiff.fitName === ret.fitName) {
                found = true;
                // verify the checks
                var works = myDiff.checks.every(f => {
                    if (!f.quantity) {
                        // if we're going from 0, make sure there are none
                        return !ret[f.location].some(vv => vv.typeName === f.typeName);
                    } else {
                        // we're going from non-zero
                        return ret[f.location].some(vv => vv.typeName === f.typeName && vv.quantity === f.quantity);
                    }
                });
                if (!works) {
                    throw Error('bad diff');
                }

                // apply the adds
                myDiff.adds.forEach(f => {
                    ret[f.location].push({
                        typeId: getTypeId(f.typeName),
                        typeName: f.typeName,
                        quantity: f.quantity,
                    });
                });
            }
        });

        ret.modules.sort(sortByTypeId);

        var keys = ['modules', 'drones', 'cargo', 'fighters'];
        for (var i = 0; i < keys.length; i++) {
            ret[keys[i]].sort(sortByTypeId);
            var len = ret[keys[i]].length;
            for (var j = 1; j < len; ) {
                if (ret[keys[i]][j].typeId === ret[keys[i]][j - 1].typeId) {
                    ret[keys[i]][j - 1].quantity += ret[keys[i]][j].quantity;
                    ret[keys[i]].splice(j, 1);
                    len--;
                } else {
                    j++;
                }
            }
            ret[keys[i]] = ret[keys[i]].filter(v => {
                if (v.quantity < 0) {
                    console.error(v);
                    throw Error('negative qty');
                }
                return !!v.quantity;
            })
        }

        return ret;
    });

    console.log(ship.name);
    console.log(ship.typeName);
    console.log(ship.locationName);
    var diffs = [];
    var maxDiffIdx = -1;
    var maxDiffScore = -Infinity;
    for (var i = 0; i < poss.length; i++) {
        diffs.push(getDiff(ship, poss[i]));
        if (diffs[i].score > maxDiffScore) {
            maxDiffIdx = i;
            maxDiffScore = diffs[i].score;
        }
    }
    console.log('********************************************');
    if (!poss.length) {
        console.log('no poss');
    } else {
        console.log(poss[maxDiffIdx].fitName);
        console.log(poss[maxDiffIdx].fitNotes);
    }
    console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    if (!diffs.length) {
        console.log('no diffs');
    } else {
        var processedDiff = processDiff(ship, diffs[maxDiffIdx]);
        console.log(processedDiff.aOnly);
        console.log(processedDiff.bOnly);
    }
    console.log('--------------------------------------------');
}

function processDiff(ship, diff) {
    // moves ammo and charges from modules to cargo
    diff.aOnly.modules = diff.aOnly.modules.filter(module => {
        if (isAmmo(module)) {
            diff.aOnly.cargo.push(module);
            return false;
        }
        return true;
    });
    diff.aOnly.cargo.sort(sortByTypeId);
    diff.bOnly.modules = diff.bOnly.modules.filter(module => {
        if (isAmmo(module)) {
            diff.bOnly.cargo.push(module);
            return false;
        }
        return true;
    });
    diff.bOnly.cargo.sort(sortByTypeId);

    var newDiff = getDiff(diff.aOnly, diff.bOnly);

    // finds all duplicate items (i.e. faction items that have the same stats)
    var keys = ['modules', 'drones', 'cargo', 'fighters'];
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (!diff.aOnly[key] || !diff.bOnly[key]) {
            continue;
        }
        diff.aOnly[key].forEach(va => {
            if (!dupeHash[va.typeId]) {
                return;
            }
            var dupe = diff.bOnly[key].find(vb => {
                return dupeHash[va.typeId].includes(vb.typeId);
            });
            if (!dupe) {
                return;
            }
            va.oldTypeId = va.typeId;
            va.oldTypeName = va.typeName;
            va.typeId = dupe.typeId;
            va.typeName = dupe.typeName;
        });
    }

    newDiff = getDiff(diff.aOnly, diff.bOnly);

    if (shouldHaveEscapeFrig(ship.typeId)) {

    }

    return newDiff;
}

function isAmmo(module) {
    var typeId = module.typeId;
    if (!typeId) {
        return false;
    }
    const query = sdeDatabase.prepare(`
        with recursive tc as (
            select parentGroupID from invMarketGroups where marketGroupID in
                (select marketGroupID from invTypes where typeID=${typeId})
            union all
            select img.parentGroupID from invMarketGroups img join tc on img.marketGroupID=tc.parentGroupID
        ) select * from tc;`);
    var results = query.all();
    if (results.length < 2) {
        // throw an error here?
        return false;
    }
    var parentGroup = results[results.length - 2].parentGroupID;
    return parentGroup === 11;
}

function getDiff(shipA, shipB) {
    var aOnly = {};
    var bOnly = {};
    var both = {};

    diffCategory('modules');
    diffCategory('drones');
    diffCategory('cargo');
    diffCategory('fighters');

    var score = both.modules.length - aOnly.modules.length - bOnly.modules.length;

    return {
        aOnly: aOnly,
        bOnly: bOnly,
        both: both,
        score: score,
    };

    function diffCategory(cat) {
        aOnly[cat] = [];
        bOnly[cat] = [];
        both[cat] = [];
        shipA[cat] = shipA[cat] || [];
        shipB[cat] = shipB[cat] || [];
        shipA[cat].sort(sortByTypeId);
        shipB[cat].sort(sortByTypeId);
        var aIdx = 0;
        var bIdx = 0;
        do {
            var shipAObj = shipA[cat][aIdx];
            var shipBObj = shipB[cat][bIdx];
            var shipAObjTypeId = shipAObj ? shipAObj.typeId : Infinity;
            var shipBObjTypeId = shipBObj ? shipBObj.typeId : Infinity;
            var objCopy1 = JSON.parse(JSON.stringify(shipAObj||{}));
            var objCopy2 = JSON.parse(JSON.stringify(shipBObj||{}));
            if (shipAObjTypeId === shipBObjTypeId) {
                if (shipAObjTypeId === Infinity) {
                    return;
                }
                var qtyDiff = shipAObj.quantity - shipBObj.quantity;
                if (qtyDiff === 0) {
                    both[cat].push(objCopy1);
                } else if (qtyDiff > 0) {
                    // A has more
                    both[cat].push(objCopy2);
                    objCopy1.quantity = qtyDiff;
                    aOnly[cat].push(objCopy1);
                } else {
                    // B has more
                    both[cat].push(objCopy1);
                    objCopy2.quantity = Math.abs(qtyDiff);
                    bOnly[cat].push(objCopy2);
                }
                aIdx++;
                bIdx++;
            } else if (shipAObjTypeId < shipBObjTypeId) {
                aOnly[cat].push(objCopy1);
                aIdx++;
            } else if (shipAObjTypeId > shipBObjTypeId) {
                bOnly[cat].push(objCopy2);
                bIdx++;
            } else {
                console.error(shipAObj);
                console.error(shipBObj);
                console.error(shipAObjTypeId);
                console.error(shipBObjTypeId);
                throw 'asdf';
            }
        } while (true);
    }
}

function sortByTypeId(a, b) {
    if (a.typeId < b.typeId) {
        return -1;
    } else if (a.typeId > b.typeId) {
        return 1;
    }
    return 0;
}
