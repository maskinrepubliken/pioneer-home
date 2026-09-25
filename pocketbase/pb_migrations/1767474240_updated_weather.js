/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pbc_3716394116")

  // update field
  collection.fields.addAt(3, new Field({
    "hidden": false,
    "id": "number1327940052",
    "max": null,
    "min": null,
    "name": "windspeed",
    "onlyInt": false,
    "presentable": false,
    "required": false,
    "system": false,
    "type": "number"
  }))

  // update field
  collection.fields.addAt(4, new Field({
    "hidden": false,
    "id": "number3434059575",
    "max": null,
    "min": null,
    "name": "winddirection",
    "onlyInt": false,
    "presentable": false,
    "required": false,
    "system": false,
    "type": "number"
  }))

  // update field
  collection.fields.addAt(5, new Field({
    "hidden": false,
    "id": "number1743635594",
    "max": null,
    "min": null,
    "name": "precipitation",
    "onlyInt": false,
    "presentable": false,
    "required": false,
    "system": false,
    "type": "number"
  }))

  // update field
  collection.fields.addAt(6, new Field({
    "hidden": false,
    "id": "date1263155164",
    "max": "",
    "min": "",
    "name": "sunrise",
    "presentable": false,
    "required": false,
    "system": false,
    "type": "date"
  }))

  // update field
  collection.fields.addAt(7, new Field({
    "hidden": false,
    "id": "date2485866111",
    "max": "",
    "min": "",
    "name": "sunset",
    "presentable": false,
    "required": false,
    "system": false,
    "type": "date"
  }))

  // update field
  collection.fields.addAt(8, new Field({
    "autogeneratePattern": "",
    "hidden": false,
    "id": "text3379474102",
    "max": 0,
    "min": 0,
    "name": "detail",
    "pattern": "",
    "presentable": false,
    "primaryKey": false,
    "required": false,
    "system": false,
    "type": "text"
  }))

  // update field
  collection.fields.addAt(9, new Field({
    "autogeneratePattern": "",
    "hidden": false,
    "id": "text487945510",
    "max": 0,
    "min": 0,
    "name": "icon",
    "pattern": "",
    "presentable": false,
    "primaryKey": false,
    "required": false,
    "system": false,
    "type": "text"
  }))

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_3716394116")

  // update field
  collection.fields.addAt(3, new Field({
    "hidden": false,
    "id": "number1327940052",
    "max": null,
    "min": null,
    "name": "windMetersPerSeconds",
    "onlyInt": false,
    "presentable": false,
    "required": false,
    "system": false,
    "type": "number"
  }))

  // update field
  collection.fields.addAt(4, new Field({
    "hidden": false,
    "id": "number3434059575",
    "max": null,
    "min": null,
    "name": "windDegrees",
    "onlyInt": false,
    "presentable": false,
    "required": false,
    "system": false,
    "type": "number"
  }))

  // update field
  collection.fields.addAt(5, new Field({
    "hidden": false,
    "id": "number1743635594",
    "max": null,
    "min": null,
    "name": "precipitationMillimetersPerHour",
    "onlyInt": false,
    "presentable": false,
    "required": false,
    "system": false,
    "type": "number"
  }))

  // update field
  collection.fields.addAt(6, new Field({
    "hidden": false,
    "id": "date1263155164",
    "max": "",
    "min": "",
    "name": "sunriseAt",
    "presentable": false,
    "required": false,
    "system": false,
    "type": "date"
  }))

  // update field
  collection.fields.addAt(7, new Field({
    "hidden": false,
    "id": "date2485866111",
    "max": "",
    "min": "",
    "name": "sunsetAt",
    "presentable": false,
    "required": false,
    "system": false,
    "type": "date"
  }))

  // update field
  collection.fields.addAt(8, new Field({
    "autogeneratePattern": "",
    "hidden": false,
    "id": "text3379474102",
    "max": 0,
    "min": 0,
    "name": "descriptions",
    "pattern": "",
    "presentable": false,
    "primaryKey": false,
    "required": false,
    "system": false,
    "type": "text"
  }))

  // update field
  collection.fields.addAt(9, new Field({
    "autogeneratePattern": "",
    "hidden": false,
    "id": "text487945510",
    "max": 0,
    "min": 0,
    "name": "categoryIcons",
    "pattern": "",
    "presentable": false,
    "primaryKey": false,
    "required": false,
    "system": false,
    "type": "text"
  }))

  return app.save(collection)
})
