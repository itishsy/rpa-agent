'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { NtExecutable, NtExecutableResource, Data, Resource } = require('resedit')

// Embed branding locally so packaging does not require downloading rcedit.
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const root = path.resolve(__dirname, '..')
  const pkg = require(path.join(root, 'package.json'))
  const target = path.join(context.appOutDir, pkg.build.productName + '.exe')
  const exe = NtExecutable.from(fs.readFileSync(target), { ignoreCert: true })
  const resources = NtExecutableResource.from(exe)
  const retained = resources.entries.filter(entry => ![3, 14, 16].includes(entry.type))
    .map(entry => ({ ...entry, bin: Buffer.from(entry.bin) }))
  const icon = Data.IconFile.from(fs.readFileSync(path.join(root, 'src/assets/app.ico')))
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries)
  for (const group of groups.length ? groups : [{ id: 1, lang: 1033 }]) {
    Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, icon.icons.map(item => item.data))
  }
  for (const version of Resource.VersionInfo.fromEntries(resources.entries)) {
    version.setFileVersion(...pkg.version.split('.').map(Number), 0, 1033)
    version.setProductVersion(...pkg.version.split('.').map(Number), 0, 1033)
    version.setStringValues({ lang: 1033, codepage: 1200 }, {
      ProductName: pkg.build.productName,
      FileDescription: pkg.build.productName,
      InternalName: pkg.name,
      OriginalFilename: pkg.build.productName + '.exe'
    })
    version.outputToResourceEntries(resources.entries)
  }
  resources.outputResource(exe)
  const result = Buffer.from(exe.generate())
  // Keep manifests and Electron ASAR integrity metadata byte-identical.
  const check = NtExecutableResource.from(NtExecutable.from(result))
  for (const entry of retained) {
    const actual = check.entries.find(item => item.type === entry.type && item.id === entry.id && item.lang === entry.lang)
    if (!actual || !Buffer.from(actual.bin).equals(entry.bin)) throw new Error('Packaging changed a non-brand resource')
  }
  fs.writeFileSync(target, result)
}
