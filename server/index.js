import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import User from "./models/userModel.js";
import Message from "./models/message.js";
import crypto from "crypto";
import http from "http";
import { Server as SocketIOServer } from "socket.io";

const app = express();

//port number
const port = 4000;
const httpServer = http.createServer(app); // Create HTTP server
const io = new SocketIOServer(httpServer); // Attach Socket.IO to the HTTP server

// middlewares
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Connect to MongoDB Database
mongoose
  .connect(
    "mongodb+srv://vanmarquez999:Sxqbw091SjaUuH7m@cluster0.snrnwms.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0"
  )
  .then(() => {
    console.log("Connected to MongoDB");
  })
  .catch(() => {
    console.log("Error Connecting to MongoDB");
  });

// setup server port
app.listen(port, () => {
  console.log(`Server Running on Port: ${port}`);
});

// route handler to regiser user
app.post("/register", async (req, res) => {
  const { name, email, password, image } = req.body;
  const newUser = new User({ name, email, password, image });
  newUser
    .save()
    .then(() => {
      res.status(200).json({ message: "User registered successfully!" });
    })
    .catch((error) => {
      console.log("Error creating a user");
      res.status(500).json({ message: "Error registering the user" });
    });
});

// route handler to login user
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    // find user email
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ message: "Invalid email" });
    }
    // compare password
    if (user.password !== password) {
      return res.status(401).json({ message: "Invalid password" });
    }
    // generate secret key
    const secretKey = crypto.randomBytes(32).toString("hex");
    // generate token
    const token = jwt.sign({ userId: user._id }, secretKey);
    res.status(200).json({ token });
  } catch (error) {
    console.log("Error logging in", error);
    res.status(500).json({ message: "Error Logging In" });
  }
});

// get users
app.get("/users/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const users = await User.find({ _id: { $ne: userId } });
    res.json(users);
  } catch (error) {
    console.log("Error", error);
  }
});

// send request
app.post("/send-request", async (req, res) => {
  const { senderId, receiverId, message } = req.body;
  const receiver = await User.findById(receiverId);
  if (!receiver) {
    return res.status(404).json({ message: "Receiver not found" });
  }
  receiver.request.push({ from: senderId, message });
  await receiver.save();
  res.status(200).json({ message: "Request sent successfully" });
  // send request realtime
  const receiverSocketId = userSocketMap[receiverId];
  if (receiverSocketId) {
    console.log("emitting request event to the receiver...", receiverId);
    io.to(receiverSocketId).emit("newRequest", receiver);
  } else {
    console.log("Receiver socket ID not found");
  }
});

app.get("/get-requests/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const user = await User.findById(userId).populate(
      "request.from",
      "name email image"
    );
    if (user) {
      res.json(user.request);
    } else {
      res.status(400);
      throw new Error("User not found");
    }
  } catch (error) {
    console.log("Error", error);
  }
});

app.post("/accept-request", async (req, res) => {
  try {
    const { userId, requestId } = req.body;
    const user = await User.findById(userId);
    // find the user
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    // remove the request
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      {
        $pull: { request: { from: requestId } },
      },
      { new: true }
    );
    // if request not found
    if (!updatedUser) {
      return res.status(404).json({ message: "Request not found" });
    }
    // add user to your friends list
    await User.findByIdAndUpdate(userId, {
      $push: { friends: requestId },
    });
    // add you to their friends list
    const friendUser = await User.findByIdAndUpdate(requestId, {
      $push: { friends: userId },
    });
    if (!friendUser) {
      return res.status(404).json({ message: "Friend not found" });
    }
    // if successfull
    res.status(200).json({ message: "Request accepted successfully" });

    // send "request is accepted" event to requester in realtime
    const requesterSocketId = userSocketMap[requestId];
    if (requesterSocketId) {
      console.log(
        "emitting accepted request event to the requester...",
        receiverId
      );
      io.to(requesterSocketId).emit("acceptedRequest");
    } else {
      console.log("Receiver socket ID not found");
    }
  } catch (error) {
    console.log("Error", error);
    res.status(500).json({ message: "Server Error" });
  }
});

app.get("/friends/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const friends = await User.findById(userId).populate(
      "friends",
      "name email image"
    );
    res.json(friends.friends);
  } catch (error) {
    console.log("Error fetching user", error);
  }
});

// send message
app.post("/sendMessage", async (req, res) => {
  try {
    const { senderId, receiverId, message } = req.body;
    const newMessage = new Message({
      senderId,
      receiverId,
      message,
    });
    await newMessage.save();
    const receiverSocketId = userSocketMap[receiverId];
    if (receiverSocketId) {
      console.log("emitting receiveMessage event to the receiver", receiverId);
      io.to(receiverSocketId).emit("newMessage", newMessage);
    } else {
      console.log("receiver socket ID not found");
    }
    res.status(201).json(newMessage);
  } catch (error) {
    console.log("Error", error);
  }
});

// get all message
app.get("/messages", async (req, res) => {
  try {
    const { senderId, receiverId } = req.query;
    const messages = await Message.find({
      $or: [
        { senderId: senderId, receiverId: receiverId },
        { senderId: receiverId, receiverId: senderId },
      ],
    }).populate("senderId", "_id name");
    res.status(200).json(messages);
  } catch (error) {
    console.log("Error", error);
  }
});

// {"userId" : "socket ID"}
const userSocketMap = {};

io.on("connection", (socket) => {
  console.log("A user is connected", socket.id);

  const userId = socket.handshake.query.userId;
  if (userId && userId !== "undefined") {
    userSocketMap[userId] = socket.id;
  }

  console.log("User socket data", userSocketMap);

  socket.on("disconnect", () => {
    console.log("User disconnected", socket.id);
    if (userId && userId !== "undefined") {
      delete userSocketMap[userId];
    }
    console.log("User socket data", userSocketMap);
  });

  socket.on("sendMessage", ({ senderId, receiverId, message }) => {
    const receiverSocketId = userSocketMap[receiverId];
    console.log("receiver Id", receiverId);

    if (receiverSocketId) {
      io.to(receiverSocketId).emit("receiverMessage", {
        senderId,
        message,
      });
    }
  });
});

httpServer.listen(3000, () => {
  console.log("Socket.IO running on Port: 3000");
});
