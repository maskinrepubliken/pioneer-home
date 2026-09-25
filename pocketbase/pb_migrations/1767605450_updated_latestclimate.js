/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pbc_4223880558")

  // update collection data
  unmarshal({
    "viewQuery": "select id, temperature, humidity, illuminance, location, sensor, max(\"when\") as \"when\"\nfrom climate\ngroup by location"
  }, collection)

  // remove field
  collection.fields.removeById("_clone_qWbN")

  // remove field
  collection.fields.removeById("_clone_lSUv")

  // remove field
  collection.fields.removeById("_clone_6PxA")

  // remove field
  collection.fields.removeById("_clone_DVmY")

  // add field
  collection.fields.addAt(1, new Field({
    "hidden": false,
    "id": "_clone_3Yyj",
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
    "id": "_clone_m7BV",
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
    "id": "_clone_OgoD",
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
    "id": "_clone_GkCZ",
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

  // add field
  collection.fields.addAt(5, new Field({
    "autogeneratePattern": "",
    "hidden": false,
    "id": "_clone_L7eo",
    "max": 0,
    "min": 0,
    "name": "sensor",
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
    "viewQuery": "select id, temperature, humidity, illuminance, location, max(\"when\") as \"when\"\nfrom climate\ngroup by location"
  }, collection)

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

  // remove field
  collection.fields.removeById("_clone_3Yyj")

  // remove field
  collection.fields.removeById("_clone_m7BV")

  // remove field
  collection.fields.removeById("_clone_OgoD")

  // remove field
  collection.fields.removeById("_clone_GkCZ")

  // remove field
  collection.fields.removeById("_clone_L7eo")

  return app.save(collection)
})
