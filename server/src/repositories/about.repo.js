'use strict';
/* Data-access for the singleton About content row. */
const db = require('../db');

const get = db.prepare('SELECT content, updated_by, updated_at FROM about_content WHERE id = 1');
const update = db.prepare(
    "UPDATE about_content SET content = @content, updated_by = @updated_by, updated_at = datetime('now') WHERE id = 1"
);
const insert = db.prepare(
    'INSERT INTO about_content (id, content, updated_by) VALUES (1, @content, @updated_by)'
);

module.exports = {
    get: () => get.get(),
    save({ content, updatedBy }) {
        const exists = get.get();
        if (exists) update.run({ content, updated_by: updatedBy });
        else insert.run({ content, updated_by: updatedBy });
        return get.get();
    },
};
