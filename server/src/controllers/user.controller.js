import fs from "fs";
import jwt from "jsonwebtoken";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { validateEmail } from "../utils/validation.js";
import { User } from "../models/user.model.js";
import { uploadOnCloudinary } from "../utils/cloudinary.js";
import { COOKIE_OPTIONS } from "../constants.js";
import {
	loginDataSchema,
	registerDataSchema,
} from "../utils/validationSchema.js";

const generateAccessAndRefreshTokens = async (userId) => {
	try {
		const user = await User.findById(userId);

		if (!user) {
			throw new ApiError(401, "Unauthorized Request", ["Bad Request"]);
		}

		const accessToken = await user.generateAccessToken();
		const refreshToken = await user.generateRefreshToken();

		user.refreshToken = refreshToken;
		await user.save({ validateBeforeSave: false });

		return {
			accessToken,
			refreshToken,
		};
	} catch (err) {
		console.log(err);
		throw new ApiError(
			500,
			"Something went wrong while generationg refresh and access tokens"
		);
	}
};

const registerUser = asyncHandler(async (req, res, next) => {
	const data = registerDataSchema.safeParse(req.body);
	const avatarLocalPath = req.file?.path;

	if (!data.success) {
		if (avatarLocalPath) {
			fs.unlinkSync(avatarLocalPath);
		}

		throw new ApiError(
			403,
			`${data.error.issues[0].path} ${data.error.issues[0].message}`,
			data.error.issues
		);
	}

	const { fullName, email, phone, password } = data;

	const existedUser = await User.findOne({
		$or: [{ email }, { phone }],
	});

	if (existedUser) {
		if (avatarLocalPath) {
			fs.unlinkSync(avatarLocalPath);
		}

		throw new ApiError(
			409,
			"User with the provided email or username already exists.",
			["Conflict"]
		);
	}

	if (!avatarLocalPath) {
		throw new ApiError(400, "Avatar is missing or invalid", ["Bad Request"]);
	}

	const avatar = await uploadOnCloudinary(avatarLocalPath);

	fs.unlinkSync(avatarLocalPath);

	if (!avatar) {
		throw new ApiError(500, "Something went wrong!", ["Server Problem"]);
	}

	const user = await User.create({
		fullName,
		email,
		password,
		avatar: avatar.url,
	});

	const createdUser = await User.findById(user._id).select(
		"-password -refreshToken"
	);
	if (createdUser) {
		return res
			.status(201)
			.json(new ApiResponse(200, createdUser, "user register successfully"));
	} else {
		return res
			.status(500)
			.json(
				new ApiError(500, "Something went wrong while registering the user", [
					"Internal Server Error",
				])
			);
	}
});

const loginUser = asyncHandler(async (req, res) => {
	// req body -> data
	// username or email
	// find the user
	// password check
	// access and refresh token
	// send cookie
	const data = loginDataSchema.safeParse(req.body);

	if (data.success) {
		console.log(data);
		throw new ApiError(
			403,
			`${data.error.issues[0].path} ${data.error.issues[0].message}`,
			data.error.issues
		);
	}

	const user = await User.findOne({
		$or: [{ email }, { phone }],
	});

	if (!user) {
		return res
			.status(200)
			.json(new ApiError(200, "Username or Password is Invalid"));
	}

	const isPasswordValid = await user.isPasswordCorrect(password);

	if (!isPasswordValid) {
		return res.status(401).json(new ApiError(401, "Invalid user credentials"));
	}

	const { accessToken, refreshToken } = await generateAccessAndRefreshTokens(
		user._id
	);

	const loggedInUser = await User.findById(user._id).select(
		"-password -refreshToken"
	);

	return res
		.status(200)
		.cookie("accessToken", accessToken, COOKIE_OPTIONS)
		.cookie("refreshToken", refreshToken, COOKIE_OPTIONS)
		.json(
			new ApiResponse(
				200,
				{
					user: loggedInUser,
					accessToken,
					refreshToken,
				},
				"user logged in successfully"
			)
		);
});

const logoutUser = asyncHandler(async (req, res) => {
	const user = req.user;
	await User.findByIdAndUpdate(
		user._id,
		{
			$set: { refreshToken: undefined },
		},
		{ new: true }
	);

	res
		.status(200)
		.clearCookie("accessToken", COOKIE_OPTIONS)
		.clearCookie("refreshToken", COOKIE_OPTIONS)
		.json(new ApiResponse(200, {}, "user logout successfully"));
});

const refreshAccessToken = asyncHandler(async (req, res) => {
	try {
		const incomingRefreshToken =
			req.cookies?.refreshToken || req.headers["authorization"].split(" ")[1];

		if (!incomingRefreshToken) {
			throw new ApiError(401, "Invalid RefreshToken", ["Unauthorized Request"]);
		}

		const decodedUser = jwt.verify(
			incomingRefreshToken,
			process.env.REFRESH_TOKEN_SECRET
		);

		const user = await User.findById(decodedUser?._id).select("-password");

		if (!user) {
			throw new ApiError(401, "Invalid RefreshToken", ["Unauthorized Request"]);
		}

		if (incomingRefreshToken !== user?.refreshToken) {
			throw new ApiError(401, "Refresh token is expired or used");
		}

		const { accessToken, refreshToken } = await generateAccessAndRefreshTokens(
			user._id
		);

		return res
			.status(200)
			.cookie("accessToken", accessToken, COOKIE_OPTIONS)
			.cookie("refreshToken", refreshToken, COOKIE_OPTIONS)
			.json(
				new ApiResponse(
					200,
					{
						user: user,
						accessToken,
						refreshToken,
					},
					"AccessToken refreshed"
				)
			);
	} catch (error) {
		throw new ApiError(
			401,
			error?.message || "Refresh token is invalid, expired or used"
		);
	}
});

const changeCurrentPassword = asyncHandler(async (req, res) => {
	const { oldPassword, newPassword } = req.body;

	if (!oldPassword || !newPassword) {
		throw new ApiError(403, "something is missing");
	}

	const user = await User.findById(req.user?._id);

	const isPasswordCorrect = user.isPasswordCorrect(oldPassword);

	if (!isPasswordCorrect) {
		throw new ApiError(401, "Old Password is incorrect");
	}

	user.password = newPassword;
	await user.save({ validateBeforeSave: false });

	return res
		.status(200)
		.json(
			new ApiResponse(
				200,
				req.user,
				"password changed successfully, please login"
			)
		);
});

const getCurrentUser = asyncHandler(async (req, res) => {
	return res.status(200).json(new ApiResponse(200, { user: req.user }));
});

const updateAccountDetails = asyncHandler(async (req, res) => {
	const { fullName, email } = req.body;

	if (!(fullName && email)) {
		throw new ApiError(401, "All fields are important");
	}

	const user = await User.findByIdAndUpdate(
		req.user?._id,
		{ $set: { fullName, email } },
		{ new: true }
	).select("-password");

	return res
		.status(200)
		.json(
			new ApiResponse(200, { user }, "Account Details Updated Successfully")
		);
});

const updateUserAvatar = asyncHandler(async (req, res) => {
	const avatarLocalPath = req.file?.path;

	if (!avatarLocalPath) {
		throw new ApiError(401, "Avatar file is missing");
	}

	const avatar = await uploadOnCloudinary(avatarLocalPath);

	if (!avatar.url) {
		throw new ApiError(500, "Error while uplaoding avatar file");
	}

	const user = await User.findByIdAndUpdate(
		req.user?._id,
		{
			$set: { avatar: avatar.url },
		},
		{ new: true }
	).select("-password");

	return res
		.status(200)
		.json(new ApiResponse(200, { user }, "Avatar Updated Successfully"));
});

export {
	registerUser,
	loginUser,
	logoutUser,
	refreshAccessToken,
	changeCurrentPassword,
	getCurrentUser,
	updateAccountDetails,
	updateUserAvatar,
};
