/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pbc_1515912424")

  // update collection data
  unmarshal({
    "indexes": [
      "CREATE INDEX `idx_OdulInKAR0` ON `climate` (`when`)"
    ],
    "name": "climate"
  }, collection)

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_1515912424")

  // update collection data
  unmarshal({
    "indexes": [
      "CREATE INDEX `idx_OdulInKAR0` ON `climates` (`when`)"
    ],
    "name": "climates"
  }, collection)

  return app.save(collection)
})
