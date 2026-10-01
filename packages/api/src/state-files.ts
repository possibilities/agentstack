import { execFile, spawnSync } from "node:child_process";
import { z } from "zod";

export const stateFile = z.strictObject({ path: z.string(), type: z.enum(["file", "directory", "symlink", "special"]),
  bytes: z.number().int().nonnegative(), modifiedAt: z.string(), revision: z.string() });
export const stateFilePage = z.strictObject({ entries: z.array(stateFile), revision: z.string(), nextOffset: z.number().int().nullable() });
export const stateFileRead = z.strictObject({ data: z.string(), encoding: z.literal("base64"), bytes: z.number().int(), totalBytes: z.number().int(),
  nextOffset: z.number().int().nullable(), revision: z.string() });
export type StateFile = z.infer<typeof stateFile>;
export type FileSelection = { all: true } | { paths: string[] };
export type FileSnapshot = { revision: string; entries: StateFile[]; bytes: number; roots: string[] };

// Node has no openat/unlinkat API on macOS. Use descriptor-relative POSIX operations
// in an isolated interpreter, rather than a path check followed by recursive rm.
// Missing Python is a reported capability failure; never fall back to path-based deletion.
const program = String.raw`
import os, sys, json, stat, hashlib, datetime, base64, uuid, errno
MAX = 10000
def digest(value): return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def identity(s): return [s.st_dev,s.st_ino,s.st_mode,s.st_size,s.st_mtime_ns,s.st_ctime_ns]
def parts(path):
    if path == '.': return []
    p = path.split('/')
    if path.startswith('/') or any(x in ('','.','..') for x in p) or '\\' in path or '\x00' in path: raise ValueError('path must be relative with no empty, dot or parent components')
    return p
def directory(parent, name): return os.open(name, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW, dir_fd=parent)
def rootfd(path):
    # The kernel resolves the owner-supplied root in one call: ancestor symlinks (macOS /tmp, a linked home or
    # state directory) are followed, the root itself must be a real directory, and everything below it is
    # descriptor-relative with no symlink traversal. Snapshots bind the root's identity, so a re-pointed
    # ancestor between plan and apply is refused as a changed selection.
    if not os.path.isabs(path): raise ValueError('root must be absolute')
    if any(x in ('.','..') for x in path.split('/')): raise ValueError('root must not contain dot or parent components')
    try: return os.open(path, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR) and os.path.islink(path): raise ValueError('root must be a directory, not a symlink')
        raise
def parentfd(root,path):
    names = parts(path)
    if not names: raise ValueError('select a file or subdirectory, not the root')
    fd = os.dup(root)
    try:
        for name in names[:-1]:
            nxt = directory(fd,name); os.close(fd); fd = nxt
        return fd,names[-1]
    except: os.close(fd); raise
def entry(fd,name,path):
    s = os.stat(name,dir_fd=fd,follow_symlinks=False)
    kind = 'file' if stat.S_ISREG(s.st_mode) else 'directory' if stat.S_ISDIR(s.st_mode) else 'symlink' if stat.S_ISLNK(s.st_mode) else 'special'
    return dict(path=path,type=kind,bytes=s.st_size,modifiedAt=datetime.datetime.fromtimestamp(s.st_mtime,datetime.timezone.utc).isoformat(),revision=digest(identity(s)))
def children(fd):
    result=[]
    with os.scandir(fd) as it:
        for item in it:
            result.append(item.name)
            if len(result)>MAX: raise ValueError('directory exceeds 10000 entries; select a smaller scope')
    return sorted(result)
def snapshot(root,selection):
    paths = children(root) if selection.get('all') is True else selection['paths']
    paths = sorted(set(paths))
    for p in paths: parts(p)
    if any(p=='.' for p in paths): raise ValueError('whole root requires all=true')
    if any(b.startswith(a+'/') for a in paths for b in paths if a!=b): raise ValueError('overlapping selections')
    rows=[]
    def visit(fd,name,path):
        before=entry(fd,name,path); rows.append(before)
        if os.stat(name,dir_fd=fd,follow_symlinks=False).st_dev != os.fstat(root).st_dev: raise ValueError('selection crosses a mounted filesystem boundary')
        if len(rows)>MAX: raise ValueError('selection exceeds 10000 entries; select a smaller scope')
        if sum(len(r['path']) for r in rows)>500000: raise ValueError('selection exceeds path budget')
        if before['type']=='special': raise ValueError('special files cannot be cleared')
        if before['type']=='directory':
            sub=directory(fd,name)
            try:
                if digest(identity(os.fstat(sub)))!=before['revision']: raise ValueError('directory changed while opening')
                for child in children(sub): visit(sub,child,path+'/'+child)
                if entry(fd,name,path)['revision']!=before['revision']: raise ValueError('directory changed while scanning')
            finally: os.close(sub)
    before=identity(os.fstat(root))
    for path in paths:
        fd,name=parentfd(root,path)
        try: visit(fd,name,path)
        finally: os.close(fd)
    if identity(os.fstat(root))!=before: raise ValueError('root changed while scanning')
    return dict(revision=digest([before,rows]),entries=rows,bytes=sum(r['bytes'] for r in rows if r['type']=='file'),roots=paths)
def run(data):
    root=rootfd(data['root'])
    try:
        mode=data['mode']; path=data.get('path','.')
        if mode=='snapshot': return snapshot(root,data['selection'])
        if mode=='retain':
            old=data['snapshot']; fresh=snapshot(root,dict(paths=[data['path']]))
            if old!=fresh: raise ValueError('retained selection changed; inspect before moving')
            targetroot=rootfd(data['targetRoot'])
            try:
                name=data['targetName']; names=parts(name)
                if len(names)!=1: raise ValueError('retained target must be one owned directory name')
                if os.fstat(root).st_dev!=os.fstat(targetroot).st_dev: raise ValueError('retention crosses a filesystem boundary')
                os.mkdir(name,mode=0o700,dir_fd=targetroot)
                destination=directory(targetroot,name)
                parent,source=parentfd(root,data['path'])
                try:
                    before=os.stat(source,dir_fd=parent,follow_symlinks=False)
                    if not stat.S_ISDIR(before.st_mode): raise ValueError('retention requires a directory')
                    os.rename(source,source,src_dir_fd=parent,dst_dir_fd=destination)
                    after=os.stat(source,dir_fd=destination,follow_symlinks=False)
                    if identity(before)[:5]!=identity(after)[:5]: raise ValueError('retention outcome unknown; inspect exact target')
                    os.fsync(parent); os.fsync(destination); os.fsync(targetroot)
                finally: os.close(parent); os.close(destination)
                return dict(retained=name+'/'+source)
            finally: os.close(targetroot)
        if mode=='list':
            fd=os.dup(root)
            try:
                for name in parts(path):
                    nxt=directory(fd,name); os.close(fd); fd=nxt
                before=identity(os.fstat(fd)); rows=[entry(fd,n,n if path=='.' else path+'/'+n) for n in children(fd)]
                if identity(os.fstat(fd))!=before: raise ValueError('directory changed while listing')
                rev=digest([before,rows])
                if data.get('revision') and data['revision']!=rev: raise ValueError('directory revision changed; restart paging')
                offset=data.get('offset',0); end=offset+data.get('limit',100)
                return dict(entries=rows[offset:end],revision=rev,nextOffset=end if end<len(rows) else None)
            finally: os.close(fd)
        if mode=='read':
            parent,name=parentfd(root,path)
            try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
            finally: os.close(parent)
            try:
                before=os.fstat(fd)
                if not stat.S_ISREG(before.st_mode): raise ValueError('only regular files can be read')
                rev=digest(identity(before))
                if data.get('revision') and data['revision']!=rev: raise ValueError('file revision changed')
                offset=data.get('offset',0); content=os.pread(fd,min(data.get('length',262144),262144),offset)
                if identity(os.fstat(fd))!=identity(before): raise ValueError('file changed while reading')
                end=offset+len(content)
                return dict(data=base64.b64encode(content).decode(),encoding='base64',bytes=len(content),totalBytes=before.st_size,nextOffset=end if end<before.st_size else None,revision=rev)
            finally: os.close(fd)
        if mode=='clear':
            old=data['snapshot']; fresh=snapshot(root,data['selection'])
            if old!=fresh: raise ValueError('selected files changed; prepare a new plan')
            rows={r['path']:r for r in old['entries']}; removed=[]
            quarantine='.stack-clear-'+str(uuid.uuid4())
            os.mkdir(quarantine,mode=0o700,dir_fd=root)
            held=directory(root,quarantine)
            def remove(fd,name,path):
                expected=rows[path]
                if entry(fd,name,path)!=expected: raise ValueError('selected file changed during cleanup')
                if expected['type']=='directory':
                    sub=directory(fd,name)
                    try:
                        initial=identity(os.fstat(sub))
                        if digest(initial)!=expected['revision']: raise ValueError('directory replaced during cleanup')
                        for child in children(sub):
                            childpath=path+'/'+child
                            if childpath not in rows: raise ValueError('new file appeared during cleanup')
                            remove(sub,child,childpath)
                        current=os.stat(name,dir_fd=fd,follow_symlinks=False)
                        if [current.st_dev,current.st_ino,current.st_mode]!=initial[:3]: raise ValueError('directory replaced during cleanup')
                        os.rmdir(name,dir_fd=fd)
                    finally: os.close(sub)
                else: os.unlink(name,dir_fd=fd)
                removed.append(path)
            try:
                for index,path in enumerate(old['roots']):
                    fd,name=parentfd(root,path)
                    try:
                        before=os.stat(name,dir_fd=fd,follow_symlinks=False)
                        if digest(identity(before))!=rows[path]['revision']: raise ValueError('selected resource changed before retirement')
                        target=str(index)
                        os.rename(name,target,src_dir_fd=fd,dst_dir_fd=held)
                        after=os.stat(target,dir_fd=held,follow_symlinks=False)
                        if identity(before)[:5]!=identity(after)[:5]: raise ValueError('resource replaced before retirement; retained in '+quarantine+'/'+target)
                        rows[path]=entry(held,target,path)
                        remove(held,target,path)
                    finally: os.close(fd)
                os.rmdir(quarantine,dir_fd=root)
                return dict(removed=removed,error=None)
            except Exception as error: return dict(removed=removed,error=str(error)+'; inspect retained quarantine '+quarantine)
            finally: os.close(held)
        raise ValueError('unknown file operation')
    finally: os.close(root)
try: print(json.dumps(dict(ok=True,data=run(json.load(sys.stdin)))))
except Exception as error: print(json.dumps(dict(ok=False,error=str(error))))
`;

async function files(input: Record<string, unknown>): Promise<unknown> {
  // execFile's callback cannot supply stdin; write once to the owned child.
  const result = await new Promise<string>((resolve, reject) => {
    const child = execFile("python3", ["-I", "-c", program], { timeout: 30_000, maxBuffer: 4_000_000 }, (error, stdout) => {
      if (error) reject(new Error(`descriptor-relative filesystem helper unavailable or interrupted: ${error.message}`)); else resolve(stdout);
    });
    child.stdin!.on("error", () => undefined);
    child.stdin!.end(JSON.stringify(input));
  });
  const value = JSON.parse(result) as { ok: boolean; data: unknown; error?: string };
  if (!value.ok) throw new Error(value.error ?? "filesystem operation failed");
  return value.data;
}
export async function listStateFiles(root: string, input: { path: string; offset: number; limit: number; revision?: string }) {
  return stateFilePage.parse(await files({ mode: "list", root, ...input }));
}
export async function readStateFile(root: string, input: { path: string; offset: number; length: number; revision?: string }) {
  return stateFileRead.parse(await files({ mode: "read", root, ...input }));
}
export async function snapshotStateFiles(root: string, selection: FileSelection): Promise<FileSnapshot> {
  return await files({ mode: "snapshot", root, selection }) as FileSnapshot;
}
export async function clearStateFiles(root: string, selection: FileSelection, snapshot: FileSnapshot): Promise<{ removed: string[]; error: string | null }> {
  return await files({ mode: "clear", root, selection, snapshot }) as { removed: string[]; error: string | null };
}
/** Move an exact owner directory without following links or overwriting another
 * retention target. Callers own both roots and persist admission before moving. */
export async function retainStateDirectory(root: string, path: string, targetRoot: string, targetName: string, snapshot: FileSnapshot): Promise<{ retained: string }> {
  return await files({ mode: "retain", root, path, targetRoot, targetName, snapshot }) as { retained: string };
}
/** Synchronous owner transaction boundary prevents new CAS references during collection. */
export function clearStateFilesSync(root: string, selection: FileSelection, snapshot: FileSnapshot): { removed: string[]; error: string | null } {
  return filesSync({ mode: "clear", root, selection, snapshot });
}
export function snapshotStateFilesSync(root: string, selection: FileSelection): FileSnapshot {
  return filesSync({ mode: "snapshot", root, selection });
}
function filesSync(input: Record<string, unknown>) {
  const result = spawnSync("python3", ["-I", "-c", program], { input: JSON.stringify(input), encoding: "utf8", timeout: 30_000, maxBuffer: 4_000_000 });
  if (result.error || result.status !== 0) throw new Error("filesystem cleanup helper interrupted; inspect the selected resources");
  const value = JSON.parse(result.stdout);
  if (!value.ok) throw new Error(value.error);
  return value.data;
}
