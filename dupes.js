const sqlite = require('node:sqlite');

var dupeHash = {};

const sdeDatabase = new sqlite.DatabaseSync('sqlite-latest.sqlite', {readOnly: true, returnArrays: true});

var cats = [9, 11];
var totalCats = [9, 11];
do {
    const query = sdeDatabase.prepare('select marketGroupID from invMarketGroups where parentGroupID in (' + cats.join(',') + ');');
    var results = query.all();
    cats = results.map(v => v.marketGroupID);
    totalCats = totalCats.concat(cats);
} while (cats.length);

for (var i = 0; i < totalCats.length; i++) {
    var cat = totalCats[i];
    const query = sdeDatabase.prepare('select typeID, groupID from invTypes where marketGroupID=' + cat);
    var results = query.all();
    if (!results.length) {
        continue;
    }

    var items = {};
    for (var j = 0; j < results.length; j++) {
        var typeId = results[j].typeID;
        var groupId = results[j].groupID;
        const dgmQuery = sdeDatabase.prepare('select effectID from dgmTypeEffects where typeID=' + typeId + ' order by effectID');
        var dgmResults = dgmQuery.all();
        const dtaQuery = sdeDatabase.prepare('select attributeID, valueInt, valueFloat from dgmTypeAttributes where typeID=' + typeId + ' order by attributeID');
        var dtaResults = dtaQuery.all();
        var key = groupId + JSON.stringify(dgmResults) + JSON.stringify(dtaResults);
        if (!items[key]) {
            items[key] = [];
        }
        items[key].push(typeId);
    }
    for (const item in items) {
        if (items[item].length > 1) {
            var arr = items[item];
            for (var j = 0; j < arr.length; j++) {
                dupeHash[arr[j]] = arr;
            }
        }
    }
}
console.log(JSON.stringify(dupeHash));
