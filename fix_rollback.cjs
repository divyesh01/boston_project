const fs = require('fs');
let code = fs.readFileSync('src/api/base44Client.js', 'utf8');

const rollbackRegex = /let totalDeleted = 0;\s*await localDb\.transaction\('rw', localDb\.ImportRecordIds, async \(\) => \{\s*for \(const row of pending\) \{\s*const ids = row\.record_ids;\s*if \(!ids\?\.length\) continue;\s*await entities\[row\.entity\]\.bulkDelete\(ids\);\s*totalDeleted \+= ids\.length;\s*await localDb\.ImportRecordIds\.update\(row\.id, \{\s*status: 'rolled_back',\s*rolled_back_at: new Date\(\)\.toISOString\(\),\s*\}\);\s*\}\s*\}\);/m;

const rollbackNew = `let totalDeleted = 0;
  for (const row of pending) {
    const ids = row.record_ids;
    if (!ids?.length) continue;
    await entities[row.entity].bulkDelete(ids);
    totalDeleted += ids.length;
    await localDb.ImportRecordIds.update(row.id, {
      status: 'rolled_back',
      rolled_back_at: new Date().toISOString(),
    });
  }`;

code = code.replace(rollbackRegex, rollbackNew);

fs.writeFileSync('src/api/base44Client.js', code);
