'use strict';
// Journal/pin adapter for existing transport fixtures. Production storage is
// covered separately; transport tests retain their original blob/project maps.
const Archive = require('../viewer/project-archive.js');
function install(ctx) {
  ctx.ProjectArchive = Archive;
  const storage = ctx.ProjectStorage;
  if (storage.putArchiveJob) return;
  const jobs = new Map(), pins = new Map(), written = new Map(), projects = new Map();
  const get = storage.getBlob && storage.getBlob.bind(storage);
  const put = storage.putBlob && storage.putBlob.bind(storage);
  const save = storage.putProject && storage.putProject.bind(storage);
  const remove = storage.deleteBlob && storage.deleteBlob.bind(storage);
  // The CAS suite supplies the production store later in fixture setup.
  const safety = () => typeof ctx.storeSafety === 'function' ? ctx.storeSafety() : null;
  storage.getBlob = async id => written.get(id) || (get && await get(id)) || null;
  storage.putBlob = async rec => {
    // The CAS fixture keeps its public Blob Map alongside the IDB adapter.
    // Write the real adapter too so atomic owner checks see the same record.
    if (safety() && ctx.storage?.stores?.blobs !== ctx.blobs) await safety().putBlob(rec);
    if (put) await put(rec); written.set(rec.id, rec); return rec.id;
  };
  storage.putProject = async (project, options) => {
    const value = save ? await save(project, options) : project;
    projects.set(project.id, JSON.parse(JSON.stringify(project))); return value;
  };
  storage.putArchiveJob = async job => safety() ? safety().putArchiveJob(job) : jobs.set(job.id, JSON.parse(JSON.stringify(job)));
  storage.getArchiveJobs = async () => safety() ? safety().getArchiveJobs() : [...jobs.values()];
  storage.deleteArchiveJob = async id => safety() ? safety().deleteArchiveJob(id) : jobs.delete(id);
  storage.pinBlobs = async (id, ids, metadata) => safety() ? safety().pinBlobs(id, ids, metadata) : pins.set(id, new Set([...(pins.get(id) || []), ...ids]));
  storage.releaseBlobPins = async id => safety() ? safety().releaseBlobPins(id) : pins.delete(id);
  storage.deleteBlob = async (id, options = {}) => {
    if (safety()) { if (!await safety().deleteBlob(id, options)) return false; }
    else if (options.ownerId && (await storage.getBlob(id))?.archiveOwnerId !== options.ownerId) return false;
    else if ([...projects.values()].some(p => JSON.stringify(p).includes('"blobId":"' + id + '"'))
      || [...pins.values()].some(set => set.has(id))
      || [...jobs.values()].some(job => (job.ownedBlobIds || []).includes(id))) return false;
    if (remove) await remove(id, options);
    written.delete(id);
    for (const map of [ctx.blobs, ctx.records]) if (map instanceof Map) map.delete(id);
    return true;
  };
  storage.__archiveTest = {get jobs() { return ctx.storage && ctx.storage.stores ? ctx.storage.stores.archive_jobs : jobs; },
    get pins() { return ctx.storage && ctx.storage.stores ? ctx.storage.stores.blob_pins : pins; }, written, projects};
}
module.exports = {install, Archive};
