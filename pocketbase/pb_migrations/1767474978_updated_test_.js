/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pbc_4223880558")

  // update collection data
  unmarshal({
    "name": "latestclimate"
  }, collection)

  // remove field
  collection.fields.removeById("_clone_leSX")

  // remove field
  collection.fields.removeById("_clone_NE8j")

  // remove field
  collection.fields.removeById("_clone_2UyF")

  // remove field
  collection.fields.removeById("_clone_Lp9M")

  // add field
  collection.fields.addAt(1, new Field({
    "hidden": false,
    "id": "_clone_qWbN",
    "max": null,
    "min": null,
    "name": "temperature",
    "onlyInt": false,
    "presentable": false,
    "required": false,
    "system": false,
    "type": "number"
  }))

  // add field
  collection.fields.addAt(2, new Field({
    "hidden": false,
    "id": "_clone_lSUv",
    "max": null,
    "min": null,
    "name": "humidity",
    "onlyInt": false,
    "presentable": false,
    "required": false,
    "system": false,
    "type": "number"
  }))

  // add field
  collection.fields.addAt(3, new Field({
    "hidden": false,
    "id": "_clone_6PxA",
    "max": null,
    "min": null,
    "name": "illuminance",
    "onlyInt": false,
    "presentable": false,
    "required": false,
    "system": false,
    "type": "number"
  }))

  // add field
  collection.fields.addAt(4, new Field({
    "autogeneratePattern": "",
    "hidden": false,
    "id": "_clone_DVmY",
    "max": 0,
    "min": 0,
    "name": "location",
    "pattern": "",
    "presentable": false,
    "primaryKey": false,
    "required": false,
    "system": false,
    "type": "text"
  }))

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_4223880558")

  // update collection data
  unmarshal({
    "name": "test"
  }, collection)

  // add field
  collection.fields.addAt(1, new Field({
    "hidden": false,
    "id": "_clone_leSX",
    "max": null,
    "min": null,
    "name": "temperature",
    "onlyInt": false,
    "presentable": false,
    "required": false,
    "system": false,
    "type": "number"
  }))

  // add field
  collection.fields.addAt(2, new Field({
    "hidden": false,
    "id": "_clone_NE8j",
    "max": null,
    "min": null,
    "name": "humidity",
    "onlyInt": false,
    "presentable": false,
    "required": false,
    "system": false,
    "type": "number"
  }))

  // add field
  collection.fields.addAt(3, new Field({
    "hidden": false,
    "id": "_clone_2UyF",
    "max": null,
    "min": null,
    "name": "illuminance",
    "onlyInt": false,
    "presentable": false,
    "required": false,
    "system": false,
    "type": "number"
  }))

  // add field
  collection.fields.addAt(4, new Field({
    "autogeneratePattern": "",
    "hidden": false,
    "id": "_clone_Lp9M",
    "max": 0,
    "min": 0,
    "name": "location",
    "pattern": "",
    "presentable": false,
    "primaryKey": false,
    "required": false,
    "system": false,
    "type": "text"
  }))

  // remove field
  collection.fields.removeById("_clone_qWbN")

  // remove field
  collection.fields.removeById("_clone_lSUv")

  // remove field
  collection.fields.removeById("_clone_6PxA")

  // remove field
  collection.fields.removeById("_clone_DVmY")

  return app.save(collection)
})
