/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pbc_4223880558")

  // update collection data
  unmarshal({
    "viewQuery": "select id, temperature, humidity, illuminance, location, sensor, max(\"when\") as \"when\"\nfrom climate\ngroup by sensor"
  }, collection)

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

  // add field
  collection.fields.addAt(1, new Field({
    "hidden": false,
    "id": "_clone_v032",
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
    "id": "_clone_zsaS",
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
    "id": "_clone_NG0x",
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
    "id": "_clone_9afE",
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
    "id": "_clone_ayrr",
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
    "viewQuery": "select id, temperature, humidity, illuminance, location, sensor, max(\"when\") as \"when\"\nfrom climate\ngroup by location"
  }, collection)

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

  // remove field
  collection.fields.removeById("_clone_v032")

  // remove field
  collection.fields.removeById("_clone_zsaS")

  // remove field
  collection.fields.removeById("_clone_NG0x")

  // remove field
  collection.fields.removeById("_clone_9afE")

  // remove field
  collection.fields.removeById("_clone_ayrr")

  return app.save(collection)
})
